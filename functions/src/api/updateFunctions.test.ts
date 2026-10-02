import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import type {Firestore} from "firebase-admin/firestore";

import {RegistryError} from "../bridge/errors.js";
import type {
  CommandContext,
  RegistryClient,
} from "../bridge/registryClient.js";
import type {
  ContactInfo,
  DomainAvailability,
  DomainCreateOutcome,
  DomainInfo,
  DomainUpdateRequest,
  HostCreateOutcome,
  HostCreateRequest,
  HostInfo,
  HostUpdateRequest,
  RegistryGreeting,
} from "../bridge/types.js";
import type {RegistryId} from "../config/options.js";
import {makeUpdateDomainHandler} from "./updateDomain.js";
import {makeUpdateContactHandler} from "./updateContact.js";
import {makeUpdateHostHandler} from "./updateHost.js";
import {makeCreateHostHandler} from "./createHost.js";

// --- Fake Firestore ---------------------------------------------------
//
// Minimal in-memory stand-in for the slice of the Firestore Admin SDK the
// production handlers use: collection/doc navigation (including nested
// `operations` subcollections), `get`, `set`/`update` with `FieldValue`
// sentinels, and `runTransaction` (executed synchronously against the
// same backing map — this suite does not exercise cross-transaction
// races, which are covered by `domain/ownership.integration.test.ts`).

type StoredDoc = Record<string, unknown>;

/** Snapshot-like shape returned by `FakeDocRef.get()`. */
interface FakeSnapshot {
  exists: boolean;
  data: () => StoredDoc | undefined;
  id: string;
}

/** Options accepted by `FakeDocRef.set`/`FakeTransaction.set`. */
interface WriteOptions {
  merge?: boolean;
}

/**
 * @param {StoredDoc} existing Document as currently stored, or `{}`.
 * @param {Record<string, unknown>} input Fields to write.
 * @param {boolean} merge Whether unspecified existing fields are kept.
 * @return {StoredDoc} The document after the write.
 */
function applyWrite(
  existing: StoredDoc,
  input: Record<string, unknown>,
  merge: boolean,
): StoredDoc {
  const base: StoredDoc = merge ? {...existing} : {};
  for (const [key, value] of Object.entries(input)) {
    if (value instanceof FieldValue) {
      if (value.isEqual(FieldValue.delete())) {
        delete base[key];
      } else {
        base[key] = new Date();
      }
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** Fake `DocumentReference`, backed by a shared in-memory map. */
class FakeDocRef {
  /**
   * @param {string} path Full document path, `"{collection}/{id}/..."`.
   * @param {string} id This document's own id.
   * @param {Map<string, StoredDoc>} store Shared backing store.
   */
  constructor(
    readonly path: string,
    readonly id: string,
    private readonly store: Map<string, StoredDoc>,
  ) {}

  /**
   * @param {string} name Subcollection name.
   * @return {FakeCollectionRef} Subcollection nested under this document.
   */
  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(`${this.path}/${name}`, this.store);
  }

  /**
   * @return {Promise<FakeSnapshot>} Snapshot-like read result.
   */
  async get(): Promise<FakeSnapshot> {
    const data = this.store.get(this.path);
    return {exists: data !== undefined, data: () => data, id: this.id};
  }

  /**
   * @param {Record<string, unknown>} input Fields to write.
   * @param {WriteOptions} options Write options.
   * @return {Promise<void>} Resolves once written.
   */
  async set(
    input: Record<string, unknown>,
    options?: WriteOptions,
  ): Promise<void> {
    const existing = this.store.get(this.path) ?? {};
    const merge = Boolean(options?.merge);
    this.store.set(this.path, applyWrite(existing, input, merge));
  }
}

/** Fake `CollectionReference`, backed by a shared in-memory map. */
class FakeCollectionRef {
  /**
   * @param {string} path Full collection path.
   * @param {Map<string, StoredDoc>} store Shared backing store.
   */
  constructor(
    private readonly path: string,
    private readonly store: Map<string, StoredDoc>,
  ) {}

  /**
   * @param {string} id Document id.
   * @return {FakeDocRef} Document within this collection.
   */
  doc(id: string): FakeDocRef {
    return new FakeDocRef(`${this.path}/${id}`, id, this.store);
  }
}

/** Fake `Transaction`: reads/writes go straight to the shared store. */
class FakeTransaction {
  /**
   * @param {Map<string, StoredDoc>} store Shared backing store.
   */
  constructor(private readonly store: Map<string, StoredDoc>) {}

  /**
   * @param {FakeDocRef} ref Document to read.
   * @return {Promise<FakeSnapshot>} Snapshot-like read result.
   */
  async get(ref: FakeDocRef): Promise<FakeSnapshot> {
    return ref.get();
  }

  /**
   * @param {FakeDocRef} ref Document to write.
   * @param {Record<string, unknown>} input Fields to write.
   * @param {WriteOptions} options Write options.
   * @return {void}
   */
  set(
    ref: FakeDocRef,
    input: Record<string, unknown>,
    options?: WriteOptions,
  ): void {
    const existing = this.store.get(ref.path) ?? {};
    const merge = Boolean(options?.merge);
    this.store.set(ref.path, applyWrite(existing, input, merge));
  }

  /**
   * @param {FakeDocRef} ref Document to update.
   * @param {Record<string, unknown>} input Fields to write.
   * @return {void}
   */
  update(ref: FakeDocRef, input: Record<string, unknown>): void {
    const existing = this.store.get(ref.path) ?? {};
    this.store.set(ref.path, applyWrite(existing, input, true));
  }
}

/** Fake `Firestore`, exposing just the surface the handlers use. */
class FakeFirestore {
  private readonly store = new Map<string, StoredDoc>();

  /**
   * @param {string} name Top-level collection name.
   * @return {FakeCollectionRef} The requested collection.
   */
  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(name, this.store);
  }

  /**
   * @param {function(FakeTransaction): Promise<T>} fn Transaction body.
   * @return {Promise<T>} Whatever `fn` resolves to.
   * @template T
   */
  async runTransaction<T>(
    fn: (tx: FakeTransaction) => Promise<T>,
  ): Promise<T> {
    return fn(new FakeTransaction(this.store));
  }

  /**
   * Seeds a document directly, bypassing `FieldValue` handling.
   *
   * @param {string} path Full document path.
   * @param {StoredDoc} doc Document contents.
   * @return {void}
   */
  seed(path: string, doc: StoredDoc): void {
    this.store.set(path, doc);
  }

  /**
   * @param {string} path Full document path.
   * @return {StoredDoc | undefined} The document's current raw state.
   */
  peek(path: string): StoredDoc | undefined {
    return this.store.get(path);
  }
}

/**
 * @return {Firestore} Fresh fake Firestore, cast to the real interface.
 */
function fakeFirestore(): Firestore {
  return new FakeFirestore() as unknown as Firestore;
}

/**
 * @param {Firestore} firestore Fake Firestore under test.
 * @return {FakeFirestore} The same instance, narrowed for `seed`/`peek`.
 */
function asFake(firestore: Firestore): FakeFirestore {
  return firestore as unknown as FakeFirestore;
}

// --- Seed helpers -------------------------------------------------------

/**
 * @param {Firestore} firestore Fake Firestore under test.
 * @param {object} fields Domain mirror fields to seed.
 * @return {void}
 */
function seedDomain(
  firestore: Firestore,
  fields: {
    uid: string;
    name: string;
    registry: RegistryId;
    syncState?: string;
    activeOperationId?: string;
  },
): void {
  const path = `domains/${fields.uid}__${fields.name}`;
  asFake(firestore).seed(path, {
    uid: fields.uid,
    name: fields.name,
    registry: fields.registry,
    syncState: fields.syncState ?? "ready",
    ...(fields.activeOperationId ?
      {activeOperationId: fields.activeOperationId} :
      {}),
  });
}

/**
 * @param {Firestore} firestore Fake Firestore under test.
 * @param {object} fields Contact mirror fields to seed.
 * @return {void}
 */
function seedContact(
  firestore: Firestore,
  fields: {
    uid: string;
    registry: RegistryId;
    contactId: string;
    state?: string;
    activeOperationId?: string;
  },
): void {
  const path = `registryContacts/${fields.uid}__${fields.registry}`;
  asFake(firestore).seed(path, {
    uid: fields.uid,
    registry: fields.registry,
    contactId: fields.contactId,
    state: fields.state ?? "ready",
    ...(fields.activeOperationId ?
      {activeOperationId: fields.activeOperationId} :
      {}),
  });
}

/**
 * @param {Firestore} firestore Fake Firestore under test.
 * @param {object} fields Host mirror fields to seed.
 * @return {void}
 */
function seedHost(
  firestore: Firestore,
  fields: {
    uid: string;
    name: string;
    parentDomain: string;
    registry: RegistryId;
    lifecycleState?: string;
    activeOperationId?: string;
  },
): void {
  const path = `registryHosts/${fields.uid}__${fields.name}`;
  asFake(firestore).seed(path, {
    uid: fields.uid,
    name: fields.name,
    parentDomain: fields.parentDomain,
    registry: fields.registry,
    lifecycleState: fields.lifecycleState ?? "ready",
    ...(fields.activeOperationId ?
      {activeOperationId: fields.activeOperationId} :
      {}),
  });
}

// --- Fake RegistryClient -------------------------------------------------

type MethodName =
  | "infoDomain"
  | "updateDomain"
  | "infoContact"
  | "updateContact"
  | "createHost"
  | "infoHost"
  | "updateHost";

interface RecordedCall {
  method: MethodName;
  args: unknown[];
}

/**
 * Records every call it receives and answers with the next queued canned
 * response for that method (a value to return, or an `Error` to throw).
 * `onCall` fires synchronously before the queued response is consumed, so
 * tests can observe Firestore state exactly at the moment a registry call
 * would go out (e.g. "reservation happened before the registry call").
 */
class FakeRegistryClient implements RegistryClient {
  readonly registry: RegistryId;
  readonly calls: RecordedCall[] = [];
  onCall?: (call: RecordedCall) => void;
  private readonly queues: Partial<Record<MethodName, unknown[]>> = {};

  /**
   * @param {RegistryId} registry Registry this fake is bound to.
   */
  constructor(registry: RegistryId) {
    this.registry = registry;
  }

  /**
   * @param {MethodName} method Method to queue an answer for.
   * @param {unknown} value Value to return, or an `Error` to throw.
   * @return {void}
   */
  enqueue(method: MethodName, value: unknown): void {
    (this.queues[method] ??= []).push(value);
  }

  /**
   * @param {MethodName} method Method being called.
   * @param {unknown[]} args Arguments the caller passed.
   * @return {unknown} The next queued value.
   */
  private consume(method: MethodName, args: unknown[]): unknown {
    const call = {method, args};
    this.calls.push(call);
    this.onCall?.(call);
    const queue = this.queues[method];
    if (!queue || queue.length === 0) {
      throw new Error(`FakeRegistryClient: no ${method} response queued`);
    }
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  }

  /** @return {Promise<RegistryGreeting>} Never resolves; unused here. */
  async hello(): Promise<RegistryGreeting> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<DomainAvailability[]>} Never resolves; unused. */
  async checkDomains(): Promise<DomainAvailability[]> {
    throw new Error("not used in this suite");
  }

  /**
   * @param {string} name Domain name.
   * @param {string} clTRID Transaction id.
   * @return {Promise<DomainInfo>} Next queued `domain:info` answer.
   */
  async infoDomain(name: string, clTRID: string): Promise<DomainInfo> {
    return this.consume("infoDomain", [name, clTRID]) as DomainInfo;
  }

  /** @return {Promise<DomainCreateOutcome>} Never resolves; unused. */
  async createDomain(): Promise<DomainCreateOutcome> {
    throw new Error("not used in this suite");
  }

  /**
   * @param {string} name Domain name.
   * @param {DomainUpdateRequest} request Wire request body.
   * @param {string} clTRID Transaction id.
   * @param {CommandContext} context Correlation ids.
   * @return {Promise<void>} Resolves once recorded.
   */
  async updateDomain(
    name: string,
    request: DomainUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    this.consume("updateDomain", [name, request, clTRID, context]);
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async createContact(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /**
   * @param {string} id Contact id.
   * @param {string} clTRID Transaction id.
   * @return {Promise<ContactInfo>} Next queued `contact:info` answer.
   */
  async infoContact(id: string, clTRID: string): Promise<ContactInfo> {
    return this.consume("infoContact", [id, clTRID]) as ContactInfo;
  }

  /**
   * @param {string} id Contact id.
   * @param {{chg: unknown}} request Wire request body.
   * @param {string} clTRID Transaction id.
   * @param {CommandContext} context Correlation ids.
   * @return {Promise<void>} Resolves once recorded.
   */
  async updateContact(
    id: string,
    request: {chg: unknown},
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    this.consume("updateContact", [id, request, clTRID, context]);
  }

  /**
   * @param {HostCreateRequest} request Wire request body.
   * @param {string} clTRID Transaction id.
   * @param {CommandContext} context Correlation ids.
   * @return {Promise<HostCreateOutcome>} Next queued `host:create` answer.
   */
  async createHost(
    request: HostCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<HostCreateOutcome> {
    const args = [request, clTRID, context];
    return this.consume("createHost", args) as HostCreateOutcome;
  }

  /**
   * @param {string} name Host name.
   * @param {string} clTRID Transaction id.
   * @return {Promise<HostInfo>} Next queued `host:info` answer.
   */
  async infoHost(name: string, clTRID: string): Promise<HostInfo> {
    return this.consume("infoHost", [name, clTRID]) as HostInfo;
  }

  /**
   * @param {string} name Host name.
   * @param {HostUpdateRequest} request Wire request body.
   * @param {string} clTRID Transaction id.
   * @param {CommandContext} context Correlation ids.
   * @return {Promise<void>} Resolves once recorded.
   */
  async updateHost(
    name: string,
    request: HostUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    this.consume("updateHost", [name, request, clTRID, context]);
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async renewDomain(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async deleteDomain(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async restoreDomain(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /**
   * AuthCode rotation has its own Callable and its own suite; the update
   * commands must never reach it (`authInfo` is unreachable in their DTOs).
   *
   * @return {Promise<never>} Never resolves; unused in this suite.
   */
  async rotateAuthInfo(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<null>} Never resolves; unused in this suite. */
  async pollMessage(): Promise<null> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async ackMessage(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async requestTransfer(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async approveTransfer(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async rejectTransfer(): Promise<never> {
    throw new Error("not used in this suite");
  }

  /** @return {Promise<never>} Never resolves; unused in this suite. */
  async cancelTransfer(): Promise<never> {
    throw new Error("not used in this suite");
  }
}

// --- Shared fixtures ------------------------------------------------------

const UID = "uid1";
const REGISTRY: RegistryId = "kitaqsign";

/**
 * @param {string} uid Caller uid on the built request.
 * @param {Record<string, unknown> | undefined} data Callable payload.
 * @return {CallableRequest<unknown>} Fake Callable request.
 */
function callableRequest(
  uid: string | undefined,
  data: Record<string, unknown> | undefined,
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? {uid, token: {} as never} : undefined,
  } as unknown as CallableRequest<unknown>;
}

/**
 * @param {Partial<DomainInfo>} overrides Fields to override.
 * @return {DomainInfo} A plausible `domain:info` answer.
 */
function domainInfoFixture(overrides: Partial<DomainInfo> = {}): DomainInfo {
  return {
    domain: "example.com",
    registry: REGISTRY,
    status: ["ok"],
    registrant: "U000001",
    contacts: {admin: "U000001", tech: "U000001"},
    nameservers: ["ns1.example.com"],
    crDate: "2026-01-01T00:00:00Z",
    upDate: null,
    exDate: "2027-01-01T00:00:00Z",
    trDate: null,
    rgpStatus: [],
    ...overrides,
  };
}

/**
 * @param {Partial<ContactInfo>} overrides Fields to override.
 * @return {ContactInfo} A plausible `contact:info` answer.
 */
function contactInfoFixture(
  overrides: Partial<ContactInfo> = {},
): ContactInfo {
  return {
    contactId: "U000001",
    registry: REGISTRY,
    postalInfo: {
      name: "Taro Test",
      addr: {street: "1 Test St", city: "Tokyo", cc: "JP"},
    },
    voice: "+81.312345678",
    email: "member@example.com",
    status: ["ok"],
    crDate: "2026-01-01T00:00:00Z",
    upDate: null,
    ...overrides,
  };
}

/**
 * @param {Partial<HostInfo>} overrides Fields to override.
 * @return {HostInfo} A plausible `host:info` answer.
 */
function hostInfoFixture(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    name: "ns1.example.com",
    registry: REGISTRY,
    addresses: [{addr: "203.0.113.5", ip: "v4"}],
    status: ["ok"],
    crDate: "2026-01-01T00:00:00Z",
    upDate: null,
    ...overrides,
  };
}

/**
 * @param {unknown} value Value to serialise.
 * @return {boolean} Whether `authInfo` appears anywhere in the value.
 */
function containsAuthInfo(value: unknown): boolean {
  return JSON.stringify(value).toLowerCase().includes("authinfo");
}

/**
 * @param {unknown} error Value thrown by a handler.
 * @param {string} code Expected `HttpsError` code.
 * @return {boolean} Whether `error` is an `HttpsError` with that code.
 */
function isHttpsErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof HttpsError && error.code === code;
}

// --- updateDomain -----------------------------------------------------

describe("updateDomain", () => {
  it("rejects an unauthenticated caller", async () => {
    const handler = makeUpdateDomainHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(callableRequest(undefined, {})),
      (error: unknown) => isHttpsErrorWithCode(error, "unauthenticated"),
    );
  });

  it("rejects a caller who does not own the domain", async () => {
    const firestore = fakeFirestore();
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "notmine.com",
          add: {nameservers: ["ns2.example.com"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "permission-denied"),
    );
  });

  it("rejects an unknown `registry` field on the DTO", async () => {
    const firestore = fakeFirestore();
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
    });
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          registry: "kitaqnic",
          add: {nameservers: ["ns2.example.com"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "invalid-argument"),
    );
  });

  it("routes via the domain's stored registry, never the client", async () => {
    const firestore = fakeFirestore();
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
    });
    const client = new FakeRegistryClient(REGISTRY);
    client.enqueue(
      "infoDomain",
      domainInfoFixture({nameservers: ["ns1.example.com"]}),
    );
    client.enqueue("updateDomain", undefined);
    client.enqueue(
      "infoDomain",
      domainInfoFixture({
        nameservers: ["ns1.example.com", "ns2.example.com"],
      }),
    );

    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: (registry) => {
        assert.equal(registry, REGISTRY);
        return client;
      },
    });

    const result = await handler(
      callableRequest(UID, {
        operationId: "op1",
        domainName: "example.com",
        add: {nameservers: ["ns2.example.com"]},
      }),
    );
    assert.equal(result.state, "ready");
    assert.equal(result.recovered, false);
  });

  it(
    "applies nameserver add/remove without ever leaking authInfo",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({
          nameservers: ["ns1.example.com", "old.example.com"],
        }),
      );
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({
          nameservers: ["ns1.example.com", "ns2.example.com"],
        }),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {nameservers: ["ns2.example.com"]},
          remove: {nameservers: ["old.example.com"]},
        }),
      );

      const updateCall = client.calls.find(
        (c) => c.method === "updateDomain",
      );
      assert.ok(updateCall);
      assert.equal(containsAuthInfo(updateCall.args[1]), false);
      assert.deepEqual(updateCall.args[1], {
        add: {nameservers: ["ns2.example.com"]},
        rem: {nameservers: ["old.example.com"]},
      });
    },
  );

  it("applies client-status add/remove", async () => {
    const firestore = fakeFirestore();
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
    });
    const client = new FakeRegistryClient(REGISTRY);
    // Real-registry status shape (spec §3.5): `ok` never coexists with any
    // other status, so a domain already holding a prohibition reports only
    // that prohibition.
    client.enqueue(
      "infoDomain",
      domainInfoFixture({
        status: ["clientTransferProhibited"],
      }),
    );
    client.enqueue("updateDomain", undefined);
    client.enqueue(
      "infoDomain",
      domainInfoFixture({status: ["clientHold"]}),
    );
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => client,
    });

    const result = await handler(
      callableRequest(UID, {
        operationId: "op1",
        domainName: "example.com",
        add: {statuses: ["clientHold"]},
        remove: {statuses: ["clientTransferProhibited"]},
      }),
    );
    assert.equal(result.state, "ready");
  });

  it(
    "applies contact add after verifying the added contact's ownership",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000002",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({contacts: {admin: "U000001"}}),
      );
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({contacts: {admin: "U000002"}}),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      const result = await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {contacts: [{role: "admin", contactId: "U000002"}]},
        }),
      );
      assert.equal(result.state, "ready");
      const updateCall = client.calls.find(
        (c) => c.method === "updateDomain",
      );
      assert.deepEqual(updateCall?.args[1], {
        add: {contacts: {admin: "U000002"}},
      });
    },
  );

  it("rejects adding a contact the caller does not own", async () => {
    const firestore = fakeFirestore();
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
    });
    // No registryContacts/uid1__kitaqsign document seeded.
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {contacts: [{role: "admin", contactId: "U000002"}]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "permission-denied"),
    );
  });

  it(
    "applies a registrant change after verifying its ownership",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000002",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({registrant: "U000001"}),
      );
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({registrant: "U000002"}),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      const result = await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          change: {registrantContactId: "U000002"},
        }),
      );
      assert.equal(result.state, "ready");
      const updateCall = client.calls.find(
        (c) => c.method === "updateDomain",
      );
      assert.deepEqual(
        (updateCall?.args[1] as DomainUpdateRequest).chg,
        {registrant: "U000002"},
      );
    },
  );

  it(
    "builds the secDNS replace extension as remove-all + add",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({secDns: undefined}));
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({
          secDns: [
            {keyTag: 1, algorithm: 8, digestType: 2, digest: "a".repeat(64)},
          ],
        }),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      const result = await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          change: {
            secDns: {
              action: "replace",
              dsData: [
                {
                  keyTag: 1,
                  algorithm: 8,
                  digestType: 2,
                  digest: "a".repeat(64),
                },
              ],
            },
          },
        }),
      );
      assert.equal(result.state, "ready");
      const updateCall = client.calls.find(
        (c) => c.method === "updateDomain",
      );
      const request = updateCall?.args[1] as DomainUpdateRequest;
      assert.deepEqual(request.extensions?.secDNS, {
        rem: {all: true},
        add: {
          dsData: [
            {keyTag: 1, algorithm: 8, digestType: 2, digest: "a".repeat(64)},
          ],
        },
      });
    },
  );

  it(
    "builds the secDNS removeAll extension as a bare remove-all",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({
          secDns: [
            {keyTag: 1, algorithm: 8, digestType: 2, digest: "a".repeat(64)},
          ],
        }),
      );
      client.enqueue("updateDomain", undefined);
      client.enqueue("infoDomain", domainInfoFixture({secDns: []}));
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          change: {secDns: {action: "removeAll"}},
        }),
      );
      const updateCall = client.calls.find(
        (c) => c.method === "updateDomain",
      );
      const request = updateCall?.args[1] as DomainUpdateRequest;
      assert.deepEqual(request.extensions?.secDNS, {rem: {all: true}});
    },
  );

  it(
    "calls domain:info before the PUT and again after it, in order",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({status: ["clientHold"]}),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {statuses: ["clientHold"]},
        }),
      );
      assert.deepEqual(
        client.calls.map((c) => c.method),
        ["infoDomain", "updateDomain", "infoDomain"],
      );
    },
  );

  it("rejects a request that would be a structural no-op", async () => {
    const firestore = fakeFirestore();
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
    });
    const client = new FakeRegistryClient(REGISTRY);
    client.enqueue(
      "infoDomain",
      domainInfoFixture({status: ["clientHold"]}),
    );
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => client,
    });

    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {statuses: ["clientHold"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "failed-precondition"),
    );
    // No PUT was ever sent for a request with no effective change.
    assert.equal(
      client.calls.filter((c) => c.method === "updateDomain").length,
      0,
    );
  });

  it(
    "treats a transport failure on the PUT as ambiguous, then replays " +
      "without resending it",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue(
        "updateDomain",
        new RegistryError({
          kind: "transport",
          registry: REGISTRY,
          command: "domain:update",
          message: "boom",
          clTRID: "x",
        }),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });
      const data = {
        operationId: "op1",
        domainName: "example.com",
        add: {statuses: ["clientHold"]},
      };

      await assert.rejects(
        handler(callableRequest(UID, data)),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "failed-precondition"),
      );
      assert.equal(
        client.calls.filter((c) => c.method === "updateDomain").length,
        1,
      );

      // Replay with the same operationId: must not resend the PUT, only
      // re-read `info` to discover the mutation actually applied.
      client.enqueue(
        "infoDomain",
        domainInfoFixture({status: ["clientHold"]}),
      );
      const result = await handler(callableRequest(UID, data));
      assert.equal(result.state, "ready");
      assert.equal(
        client.calls.filter((c) => c.method === "updateDomain").length,
        1,
      );
    },
  );

  it(
    "treats a post-mutation info matching the prior state as not " +
      "applied (EPP 1001 style delay)",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue("updateDomain", undefined);
      // Registry accepted the command (1001-style pending) but the
      // change is not visible yet: post-info still matches pre-mutation.
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            domainName: "example.com",
            add: {statuses: ["clientHold"]},
          }),
        ),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "failed-precondition"),
      );
    },
  );

  it(
    "treats a post-mutation info failure as ambiguous, not unavailable",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        new RegistryError({
          kind: "transport",
          registry: REGISTRY,
          command: "domain:info",
          message: "boom",
          clTRID: "x",
        }),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            domainName: "example.com",
            add: {statuses: ["clientHold"]},
          }),
        ),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "failed-precondition"),
      );
    },
  );

  it(
    "replays a succeeded operationId without hitting the registry again",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({status: ["clientHold"]}),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });
      const data = {
        operationId: "op1",
        domainName: "example.com",
        add: {statuses: ["clientHold"]},
      };

      const first = await handler(callableRequest(UID, data));
      assert.equal(first.recovered, false);
      const callsAfterFirst = client.calls.length;

      const second = await handler(callableRequest(UID, data));
      assert.equal(second.recovered, true);
      assert.equal(client.calls.length, callsAfterFirst);
    },
  );

  it(
    "rejects the same operationId reused with a different request",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoDomain", domainInfoFixture({status: ["ok"]}));
      client.enqueue("updateDomain", undefined);
      client.enqueue(
        "infoDomain",
        domainInfoFixture({status: ["clientHold"]}),
      );
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          domainName: "example.com",
          add: {statuses: ["clientHold"]},
        }),
      );

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            domainName: "example.com",
            add: {statuses: ["clientTransferProhibited"]},
          }),
        ),
        (error: unknown) => isHttpsErrorWithCode(error, "invalid-argument"),
      );
    },
  );

  it("rejects a concurrent operation on the same domain", async () => {
    const firestore = fakeFirestore();
    // `syncState: "ready"` so the ownership check (a *different*, earlier
    // gate) passes; `activeOperationId` set anyway to exercise
    // `beginMutation`'s own concurrency check in isolation.
    seedDomain(firestore, {
      uid: UID,
      name: "example.com",
      registry: REGISTRY,
      activeOperationId: "already-running",
    });
    const handler = makeUpdateDomainHandler({
      firestore,
      getClient: () => new FakeRegistryClient(REGISTRY),
    });

    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "new-op",
          domainName: "example.com",
          add: {statuses: ["clientHold"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "aborted"),
    );
  });

  it(
    "does not let a mismatched operationId resume the caller's own " +
      "dispatching operation",
    async () => {
      const firestore = fakeFirestore();
      // `syncState: "updating"` with `activeOperationId: "op-A"` models a
      // domain left `not_ready` by a prior in-flight attempt.
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
        syncState: "updating",
        activeOperationId: "op-A",
      });
      const client = new FakeRegistryClient(REGISTRY);
      const handler = makeUpdateDomainHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op-B",
            domainName: "example.com",
            add: {statuses: ["clientHold"]},
          }),
        ),
        (error: unknown) => {
          if (!isHttpsErrorWithCode(error, "failed-precondition")) {
            return false;
          }
          // Same generic "not ready" message a caller who never owned
          // this domain's in-flight operation would see — must not leak
          // the existence or id of the active operation.
          const message = (error as HttpsError).message;
          return !message.includes("op-A") && !message.includes("op-B");
        },
      );
      // The wrapper must fail before ever reaching the registry.
      assert.equal(client.calls.length, 0);
    },
  );
});

// --- updateContact ------------------------------------------------------

describe("updateContact", () => {
  it("rejects an unauthenticated caller", async () => {
    const handler = makeUpdateContactHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(callableRequest(undefined, {})),
      (error: unknown) => isHttpsErrorWithCode(error, "unauthenticated"),
    );
  });

  it("rejects a caller who does not own the context domain", async () => {
    const handler = makeUpdateContactHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          contactId: "U000001",
          contextDomainName: "notmine.com",
          change: {voice: "+81.312345678"},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "permission-denied"),
    );
  });

  it(
    "rejects a caller who does not own the contact on the registry",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      // No registryContacts/uid1__kitaqsign document seeded.
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => new FakeRegistryClient(REGISTRY),
      });
      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            contactId: "U000001",
            contextDomainName: "example.com",
            change: {voice: "+81.312345678"},
          }),
        ),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "permission-denied"),
      );
    },
  );

  it(
    "rebuilds the full wire object, preserving unspecified fields",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000001",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoContact", contactInfoFixture());
      client.enqueue("updateContact", undefined);
      client.enqueue(
        "infoContact",
        contactInfoFixture({voice: "+81.398765432"}),
      );
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => client,
      });

      const result = await handler(
        callableRequest(UID, {
          operationId: "op1",
          contactId: "U000001",
          contextDomainName: "example.com",
          change: {voice: "+81.398765432"},
        }),
      );
      assert.equal(result.state, "ready");

      const updateCall = client.calls.find(
        (c) => c.method === "updateContact",
      );
      assert.equal(containsAuthInfo(updateCall?.args[1]), false);
      const chg = (
        updateCall?.args[1] as {chg: Record<string, unknown>}
      ).chg;
      assert.deepEqual(chg.postalInfo, contactInfoFixture().postalInfo);
      assert.equal(chg.email, contactInfoFixture().email);
      assert.equal(chg.voice, "+81.398765432");
    },
  );

  it(
    "calls contact:info before the PUT and again after it, in order",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000001",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoContact", contactInfoFixture());
      client.enqueue("updateContact", undefined);
      client.enqueue(
        "infoContact",
        contactInfoFixture({voice: "+81.398765432"}),
      );
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          contactId: "U000001",
          contextDomainName: "example.com",
          change: {voice: "+81.398765432"},
        }),
      );
      assert.deepEqual(
        client.calls.map((c) => c.method),
        ["infoContact", "updateContact", "infoContact"],
      );
    },
  );

  it(
    "treats a transport failure on the PUT as ambiguous, then replays " +
      "without resending it",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000001",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("infoContact", contactInfoFixture());
      client.enqueue(
        "updateContact",
        new RegistryError({
          kind: "transport",
          registry: REGISTRY,
          command: "contact:update",
          message: "boom",
          clTRID: "x",
        }),
      );
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => client,
      });
      const data = {
        operationId: "op1",
        contactId: "U000001",
        contextDomainName: "example.com",
        change: {voice: "+81.398765432"},
      };

      await assert.rejects(
        handler(callableRequest(UID, data)),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "failed-precondition"),
      );

      client.enqueue(
        "infoContact",
        contactInfoFixture({voice: "+81.398765432"}),
      );
      const result = await handler(callableRequest(UID, data));
      assert.equal(result.state, "ready");
      assert.equal(
        client.calls.filter((c) => c.method === "updateContact").length,
        1,
      );
    },
  );

  it(
    "does not let a mismatched operationId resume the caller's own " +
      "dispatching operation",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      // `state: "updating"` with `activeOperationId: "op-A"` models a
      // contact left `not_ready` by a prior in-flight attempt.
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000001",
        state: "updating",
        activeOperationId: "op-A",
      });
      const client = new FakeRegistryClient(REGISTRY);
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op-B",
            contactId: "U000001",
            contextDomainName: "example.com",
            change: {voice: "+81.398765432"},
          }),
        ),
        (error: unknown) => {
          if (!isHttpsErrorWithCode(error, "failed-precondition")) {
            return false;
          }
          const message = (error as HttpsError).message;
          return !message.includes("op-A") && !message.includes("op-B");
        },
      );
      assert.equal(client.calls.length, 0);
    },
  );

  it(
    "rejects a request that would be a structural no-op",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      seedContact(firestore, {
        uid: UID,
        registry: REGISTRY,
        contactId: "U000001",
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "infoContact",
        contactInfoFixture({voice: "+81.312345678"}),
      );
      const handler = makeUpdateContactHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            contactId: "U000001",
            contextDomainName: "example.com",
            change: {voice: "+81.312345678"},
          }),
        ),
        (error: unknown) => isHttpsErrorWithCode(error, "failed-precondition"),
      );
      // No PUT was ever sent for a request with no effective change.
      assert.equal(
        client.calls.filter((c) => c.method === "updateContact").length,
        0,
      );
    },
  );
});

// --- updateHost ---------------------------------------------------------

describe("updateHost", () => {
  it("rejects an unauthenticated caller", async () => {
    const handler = makeUpdateHostHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(callableRequest(undefined, {})),
      (error: unknown) => isHttpsErrorWithCode(error, "unauthenticated"),
    );
  });

  it("rejects a caller who does not own the host", async () => {
    const handler = makeUpdateHostHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          hostName: "ns1.notmine.com",
          add: {addresses: ["203.0.113.9"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "permission-denied"),
    );
  });

  it("applies address add/remove, tagging v4/v6 correctly", async () => {
    const firestore = fakeFirestore();
    seedHost(firestore, {
      uid: UID,
      name: "ns1.example.com",
      parentDomain: "example.com",
      registry: REGISTRY,
    });
    const client = new FakeRegistryClient(REGISTRY);
    client.enqueue(
      "infoHost",
      hostInfoFixture({addresses: [{addr: "203.0.113.5", ip: "v4"}]}),
    );
    client.enqueue("updateHost", undefined);
    client.enqueue(
      "infoHost",
      hostInfoFixture({
        addresses: [
          {addr: "203.0.113.9", ip: "v4"},
          {addr: "2001:db8::1", ip: "v6"},
        ],
      }),
    );
    const handler = makeUpdateHostHandler({
      firestore,
      getClient: () => client,
    });

    const result = await handler(
      callableRequest(UID, {
        operationId: "op1",
        hostName: "ns1.example.com",
        add: {addresses: ["203.0.113.9", "2001:db8::1"]},
        remove: {addresses: ["203.0.113.5"]},
      }),
    );
    assert.equal(result.state, "ready");

    const updateCall = client.calls.find((c) => c.method === "updateHost");
    assert.deepEqual(updateCall?.args[1], {
      add: {
        addrs: [
          {addr: "203.0.113.9", ip: "v4"},
          {addr: "2001:db8::1", ip: "v6"},
        ],
      },
      rem: {addrs: [{addr: "203.0.113.5", ip: "v4"}]},
    });
  });

  it("rejects a request that would be a structural no-op", async () => {
    const firestore = fakeFirestore();
    seedHost(firestore, {
      uid: UID,
      name: "ns1.example.com",
      parentDomain: "example.com",
      registry: REGISTRY,
    });
    const client = new FakeRegistryClient(REGISTRY);
    client.enqueue(
      "infoHost",
      hostInfoFixture({addresses: [{addr: "203.0.113.5", ip: "v4"}]}),
    );
    const handler = makeUpdateHostHandler({
      firestore,
      getClient: () => client,
    });

    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          hostName: "ns1.example.com",
          add: {addresses: ["203.0.113.5"]},
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "failed-precondition"),
    );
    assert.equal(
      client.calls.filter((c) => c.method === "updateHost").length,
      0,
    );
  });

  it(
    "does not let a mismatched operationId resume the caller's own " +
      "dispatching operation",
    async () => {
      const firestore = fakeFirestore();
      // `lifecycleState: "updating"` with `activeOperationId: "op-A"`
      // models a host left `not_ready` by a prior in-flight attempt.
      seedHost(firestore, {
        uid: UID,
        name: "ns1.example.com",
        parentDomain: "example.com",
        registry: REGISTRY,
        lifecycleState: "updating",
        activeOperationId: "op-A",
      });
      const client = new FakeRegistryClient(REGISTRY);
      const handler = makeUpdateHostHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op-B",
            hostName: "ns1.example.com",
            add: {addresses: ["203.0.113.9"]},
          }),
        ),
        (error: unknown) => {
          if (!isHttpsErrorWithCode(error, "failed-precondition")) {
            return false;
          }
          const message = (error as HttpsError).message;
          return !message.includes("op-A") && !message.includes("op-B");
        },
      );
      assert.equal(client.calls.length, 0);
    },
  );
});

// --- createHost -----------------------------------------------------------

describe("createHost", () => {
  it("rejects an unauthenticated caller", async () => {
    const handler = makeCreateHostHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(callableRequest(undefined, {})),
      (error: unknown) => isHttpsErrorWithCode(error, "unauthenticated"),
    );
  });

  it("rejects a caller who does not own the parent domain", async () => {
    const handler = makeCreateHostHandler({
      firestore: fakeFirestore(),
      getClient: () => new FakeRegistryClient(REGISTRY),
    });
    await assert.rejects(
      handler(
        callableRequest(UID, {
          operationId: "op1",
          parentDomainName: "notmine.com",
          hostName: "ns1.notmine.com",
          addresses: ["203.0.113.5"],
        }),
      ),
      (error: unknown) => isHttpsErrorWithCode(error, "permission-denied"),
    );
  });

  it(
    "reserves the host doc as `creating` before calling the registry",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      const hostPath = `registryHosts/${UID}__ns1.example.com`;
      let observedAtCreateCall: unknown;
      client.onCall = (call) => {
        if (call.method === "createHost") {
          observedAtCreateCall =
            asFake(firestore).peek(hostPath)?.lifecycleState;
        }
      };
      client.enqueue("createHost", {
        name: "ns1.example.com",
        registry: REGISTRY,
        crDate: "2026-01-01T00:00:00Z",
        clTRID: "x",
        svTRID: "y",
      });
      client.enqueue("infoHost", hostInfoFixture());
      const handler = makeCreateHostHandler({
        firestore,
        getClient: () => client,
      });

      const result = await handler(
        callableRequest(UID, {
          operationId: "op1",
          parentDomainName: "example.com",
          hostName: "ns1.example.com",
          addresses: ["203.0.113.5"],
        }),
      );
      assert.equal(result.state, "ready");
      assert.equal(observedAtCreateCall, "creating");
      assert.equal(
        asFake(firestore).peek(hostPath)?.lifecycleState,
        "ready",
      );
    },
  );

  it(
    "never leaks authInfo, and confirms via a post-create infoHost read",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("createHost", {
        name: "ns1.example.com",
        registry: REGISTRY,
        crDate: "2026-01-01T00:00:00Z",
        clTRID: "x",
        svTRID: "y",
      });
      client.enqueue("infoHost", hostInfoFixture());
      const handler = makeCreateHostHandler({
        firestore,
        getClient: () => client,
      });

      await handler(
        callableRequest(UID, {
          operationId: "op1",
          parentDomainName: "example.com",
          hostName: "ns1.example.com",
          addresses: ["203.0.113.5"],
        }),
      );
      const createCall = client.calls.find(
        (c) => c.method === "createHost",
      );
      assert.equal(containsAuthInfo(createCall?.args[0]), false);
      assert.deepEqual(
        client.calls.map((c) => c.method),
        ["createHost", "infoHost"],
      );
    },
  );

  it(
    "maps EPP 2302 to already-exists and never adopts the host",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue(
        "createHost",
        new RegistryError({
          kind: "objectExists",
          registry: REGISTRY,
          command: "host:create",
          message: "2302",
          clTRID: "x",
          resultCode: 2302,
        }),
      );
      const handler = makeCreateHostHandler({
        firestore,
        getClient: () => client,
      });

      await assert.rejects(
        handler(
          callableRequest(UID, {
            operationId: "op1",
            parentDomainName: "example.com",
            hostName: "ns1.example.com",
            addresses: ["203.0.113.5"],
          }),
        ),
        (error: unknown) => isHttpsErrorWithCode(error, "already-exists"),
      );

      const hostPath = `registryHosts/${UID}__ns1.example.com`;
      assert.equal(
        asFake(firestore).peek(hostPath)?.lifecycleState,
        "conflict",
      );

      // The host is not usable: a follow-up updateHost must not treat it
      // as ready (ownership.ts collapses "conflict" into the same
      // "owned but not ready" outcome as an in-flight mutation).
      const updateHandler = makeUpdateHostHandler({
        firestore,
        getClient: () => client,
      });
      await assert.rejects(
        updateHandler(
          callableRequest(UID, {
            operationId: "op2",
            hostName: "ns1.example.com",
            add: {addresses: ["203.0.113.9"]},
          }),
        ),
        (error: unknown) =>
          isHttpsErrorWithCode(error, "failed-precondition"),
      );
    },
  );

  it(
    "replays a succeeded operationId without hitting the registry again",
    async () => {
      const firestore = fakeFirestore();
      seedDomain(firestore, {
        uid: UID,
        name: "example.com",
        registry: REGISTRY,
      });
      const client = new FakeRegistryClient(REGISTRY);
      client.enqueue("createHost", {
        name: "ns1.example.com",
        registry: REGISTRY,
        crDate: "2026-01-01T00:00:00Z",
        clTRID: "x",
        svTRID: "y",
      });
      client.enqueue("infoHost", hostInfoFixture());
      const handler = makeCreateHostHandler({
        firestore,
        getClient: () => client,
      });
      const data = {
        operationId: "op1",
        parentDomainName: "example.com",
        hostName: "ns1.example.com",
        addresses: ["203.0.113.5"],
      };

      const first = await handler(callableRequest(UID, data));
      assert.equal(first.recovered, false);
      const callCount = client.calls.length;

      const second = await handler(callableRequest(UID, data));
      assert.equal(second.recovered, true);
      assert.equal(client.calls.length, callCount);
    },
  );
});
