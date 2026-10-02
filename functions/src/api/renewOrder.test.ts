import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {afterEach, before, describe, it, mock} from "node:test";

import {FieldValue, Timestamp} from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import type {CallableRequest} from "firebase-functions/v2/https";

import {AUTH_PROVIDER, USER_STATUS} from "../auth/constants";
import {userDocument} from "../auth/firestore";
import type {ActiveUser} from "../auth/types";
import {EppClient, type EppRequest, type EppSuccess} from "../bridge/eppClient";
import {EPP_RESULT} from "../bridge/types";
import type {RegistryId} from "../config/options";
import {COLLECTIONS, db} from "../config/firebase";
import {expectedRenewalExDate} from "../domain/validation";
import {renewOrder} from "./renewOrder";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "teamc-2026";
const REGISTRY: RegistryId = "kitaqsign";

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for these tests.",
  );
});

afterEach(() => {
  mock.restoreAll();
});

const functionsTest = firebaseFunctionsTest({projectId: PROJECT_ID});
const wrappedRenewOrder = functionsTest.wrap(renewOrder);

/**
 * Builds the request shape received after Callable authentication succeeds.
 *
 * @param {string | undefined} uid Authenticated fixture UID, or undefined for
 *   an unauthenticated call.
 * @param {unknown} data Callable request data.
 * @return {CallableRequest<unknown>} Synthetic Callable request.
 */
function callableRequest(
  uid: string | undefined,
  data: unknown = {},
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ?
      {uid, token: {uid, sub: uid, auth_time: Math.floor(Date.now() / 1000)}} :
      undefined,
    acceptsStreaming: false,
    rawRequest: {},
  } as CallableRequest<unknown>;
}

/**
 * Asserts that a Callable rejects with one stable Functions error code.
 *
 * @param {Function} action Callable invocation.
 * @param {string} expectedCode Expected HttpsError code.
 * @return {Promise<void>} Resolves after the rejection is verified.
 */
async function assertRejectsWithCode(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as {code?: unknown}).code, expectedCode);
    return true;
  });
}

/** Minimal but complete profile for a seeded active member fixture. */
const FIXTURE_PROFILE: ActiveUser["profile"] = {
  accountType: "individual",
  address: {
    addressLine: "1-1-1",
    building: null,
    city: "千代田区",
    country: "JP",
    postalCode: "100-0001",
    prefecture: "東京都",
  },
  business: null,
  dateOfBirth: "1990-01-01",
  gender: "no_answer",
  name: "Test Member",
  nameKana: "テストメンバー",
  newsletterOptIn: false,
  phoneNumber: "090-0000-0000",
};

/**
 * Writes an active users/{uid} document, so the caller clears
 * `requireActiveUser` (src/auth/callerGuard.ts).
 *
 * @param {string} uid Fixture uid.
 * @return {Promise<void>} Resolves once the document is written.
 */
async function seedActiveUser(uid: string): Promise<void> {
  const now = Timestamp.now();
  const user: ActiveUser = {
    authProvider: AUTH_PROVIDER.PASSWORD,
    createdAt: now,
    deletionRequestedAt: null,
    email: `${uid}@example.com`,
    profile: FIXTURE_PROFILE,
    purgeTaskName: null,
    scheduledPurgeAt: null,
    status: USER_STATUS.ACTIVE,
    uid,
    updatedAt: now,
  };
  await userDocument(uid).set(user);
}

interface DomainFixture {
  uid: string;
  domainName: string;
  curExpDate: string;
}

/**
 * Seeds an owned Domain document and an active user document for its owner,
 * without opening any Order.
 *
 * @param {object} [overrides] Optional registry/exDate/status overrides.
 * @return {Promise<DomainFixture>} Fixture identifiers.
 */
async function seedDomain(overrides?: {
  registry?: RegistryId;
  exDate?: string;
  status?: string[];
}): Promise<DomainFixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const uid = `uid-${suffix}`;
  const domainName = `renew-api-${suffix}.com`;
  const curExpDate = overrides?.exDate ?? "2027-05-05";

  await seedActiveUser(uid);
  await db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`)
    .set({
      uid,
      name: domainName,
      tld: "com",
      registry: overrides?.registry ?? REGISTRY,
      status: overrides?.status ?? [],
      rgpStatus: [],
      nameservers: [],
      // Real-registry shape: the mirror stores the registry's ISO-datetime
      // answer verbatim, while the order snapshot must come out date-only.
      exDate: `${curExpDate}T03:02:41Z`,
      autoRenew: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return {uid, domainName, curExpDate};
}

/**
 * Builds a successful `domain:renew` EppSuccess envelope, answering the
 * expiry in the real registries' ISO-datetime wire shape (a date-only
 * argument is expanded; anything else passes through verbatim).
 *
 * @param {string} domain Domain name echoed back.
 * @param {string} exDate New expiry to answer with.
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function renewSuccess(domain: string, exDate: string): EppSuccess<unknown> {
  const wireExDate = /^\d{4}-\d{2}-\d{2}$/.test(exDate) ?
    `${exDate}T03:02:41Z` :
    exDate;
  return {
    httpStatus: 200,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {domain, exDate: wireExDate},
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-1",
    tolerated: false,
  };
}

/** Per-command async response handlers for {@link stubSend}. */
interface SendHandlers {
  "domain:renew"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
}

/**
 * Stubs `EppClient.prototype.send`, dispatching on `request.command`.
 *
 * @param {SendHandlers} handlers Per-command async handlers.
 * @return {object} The installed mock, for inspecting `.mock.calls`.
 */
function stubSend(handlers: SendHandlers) {
  return mock.method(
    EppClient.prototype,
    "send",
    async (request: EppRequest) => {
      const command = request.command as keyof SendHandlers;
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`unexpected command in test stub: ${command}`);
      }
      return handler(request);
    },
  );
}

// --- auth and validation -----------------------------------------------------

describe("renewOrder — auth and validation", () => {
  it("rejects an unauthenticated call", async () => {
    await assertRejectsWithCode(
      () => wrappedRenewOrder(callableRequest(undefined, {})),
      "unauthenticated",
    );
  });

  it("rejects an invalid domain name", async () => {
    const fixture = await seedDomain();
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: "not a domain",
          periodYears: 1,
          idempotencyKey: "key-invalid-domain-01",
        })),
      "invalid-argument",
    );
  });

  it("rejects a periodYears out of the 1-10 range", async () => {
    const fixture = await seedDomain();
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: fixture.domainName,
          periodYears: 11,
          idempotencyKey: "key-invalid-period-01",
        })),
      "invalid-argument",
    );
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: fixture.domainName,
          periodYears: 0,
          idempotencyKey: "key-invalid-period-02",
        })),
      "invalid-argument",
    );
  });

  it("rejects a missing idempotencyKey", async () => {
    const fixture = await seedDomain();
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: fixture.domainName,
          periodYears: 1,
        })),
      "invalid-argument",
    );
  });

  it("rejects a mirror without an exDate as failed-precondition, not as " +
    "the format-validation 400", async () => {
    // Contract-legal gap: both registries' OpenAPI leave exDate out of the
    // info response's required set, so a mirror may hold none.
    const fixture = await seedDomain();
    await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .set({exDate: FieldValue.delete()}, {merge: true});

    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: fixture.domainName,
          periodYears: 1,
          idempotencyKey: "key-no-exdate-01",
        })),
      "failed-precondition",
    );
  });

  it("rejects when the caller owns no such Domain document", async () => {
    const uid = `uid-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await seedActiveUser(uid);
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(uid, {
          domainName: "nonexistent-domain.com",
          periodYears: 1,
          idempotencyKey: "key-no-domain-01",
        })),
      "not-found",
    );
  });

  it("rejects a signed-in caller with no user document", async () => {
    // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
    // ID token alone — mintable straight against Identity Toolkit's public
    // accounts:signUp — must not be enough to reach this Callable.
    const uid = `uid-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(uid, {
          domainName: "no-user-doc.com",
          periodYears: 1,
          idempotencyKey: "key-no-user-doc-01",
        })),
      "permission-denied",
    );
  });
});

// --- ownership, registry, status, price, snapshot ----------------------------

describe("renewOrder — registry, status, price, and snapshot", () => {
  it("uses the Domain document's stored registry, not TLD routing",
    async () => {
      const fixture = await seedDomain({registry: "kitaqnic"});
      stubSend({
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, "2028-05-05"),
      });

      const result = await wrappedRenewOrder(callableRequest(fixture.uid, {
        domainName: fixture.domainName,
        periodYears: 1,
        idempotencyKey: "key-registry-01",
      })) as {registry: string; state: string};

      assert.equal(result.state, "done");
      assert.equal(result.registry, "kitaqnic");
    });

  it("does not use domain status to reject the renewal", async () => {
    const fixture = await seedDomain({
      status: ["clientRenewProhibited", "pendingTransfer"],
    });
    stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, "2028-05-05"),
    });

    const result = await wrappedRenewOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: "key-status-01",
    })) as {state: string};

    assert.equal(result.state, "done");
  });

  it("ignores caller-supplied price fields and computes priceYen itself",
    async () => {
      const fixture = await seedDomain();
      stubSend({
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, "2028-05-05"),
      });

      const result = await wrappedRenewOrder(callableRequest(fixture.uid, {
        domainName: fixture.domainName,
        periodYears: 1,
        idempotencyKey: "key-price-01",
        priceYen: 1,
      })) as {priceYen: number};

      assert.ok(result.priceYen > 1);
    });

  it("computes and stores the curExpDate/expectedExDate snapshot", async () => {
    const fixture = await seedDomain({exDate: "2028-02-29"});
    stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, "2029-03-01"),
    });

    await wrappedRenewOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: "key-snapshot-01",
    }));

    const orderSnap = await db()
      .collection(COLLECTIONS.orders)
      .doc(`${fixture.uid}__key-snapshot-01`)
      .get();
    assert.equal(orderSnap.data()?.curExpDate, "2028-02-29");
    assert.equal(
      orderSnap.data()?.expectedExDate,
      expectedRenewalExDate("2028-02-29", 1),
    );
  });
});

// --- idempotency, kind collision, concurrency --------------------------------

describe("renewOrder — idempotency, kind collision, and concurrency", () => {
  it("reuses the existing order for a repeat key without re-charging or " +
    "recomputing the snapshot", async () => {
    const fixture = await seedDomain();
    stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, "2028-05-05"),
    });

    const first = await wrappedRenewOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: "key-repeat-01",
    })) as {orderId: string; state: string};
    assert.equal(first.state, "done");

    // Mutate the Domain's exDate after the first call, simulating drift; a
    // reused order must not recompute its snapshot from the new value.
    await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .set({exDate: "2030-01-01"}, {merge: true});

    mock.restoreAll();
    const send = stubSend({});
    const second = await wrappedRenewOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: "key-repeat-01",
    })) as {orderId: string; state: string};

    assert.equal(second.orderId, first.orderId);
    assert.equal(second.state, "done");
    assert.equal(send.mock.calls.length, 0);
  });

  it("rejects a key already used by a create order", async () => {
    const fixture = await seedDomain();
    await db()
      .collection(COLLECTIONS.orders)
      .doc(`${fixture.uid}__key-collision-01`)
      .set({
        uid: fixture.uid,
        seq: 1,
        kind: "create",
        domainName: fixture.domainName,
        registry: REGISTRY,
        periodYears: 1,
        nameservers: [],
        priceYen: 1500,
        state: "done",
        attempts: 1,
        idempotencyKey: "key-collision-01",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

    await assertRejectsWithCode(
      () =>
        wrappedRenewOrder(callableRequest(fixture.uid, {
          domainName: fixture.domainName,
          periodYears: 1,
          idempotencyKey: "key-collision-01",
        })),
      "invalid-argument",
    );
  });

  it(
    "two different idempotency keys racing the same domain: registry " +
    "renewDomain fires at most once, one order done and the other failed",
    async () => {
      let unblock: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let started: () => void = () => undefined;
      const startedGate = new Promise<void>((resolve) => {
        started = resolve;
      });

      const fixture = await seedDomain();
      const send = mock.method(
        EppClient.prototype,
        "send",
        async (request: EppRequest) => {
          if (request.command !== "domain:renew") {
            throw new Error(
              `unexpected command in test stub: ${request.command}`,
            );
          }
          started();
          await gate;
          return renewSuccess(fixture.domainName, "2028-05-05");
        },
      );

      const firstCall = wrappedRenewOrder(callableRequest(fixture.uid, {
        domainName: fixture.domainName,
        periodYears: 1,
        idempotencyKey: "key-race-a",
      })) as Promise<{state: string}>;
      await startedGate;

      const secondCall = wrappedRenewOrder(callableRequest(fixture.uid, {
        domainName: fixture.domainName,
        periodYears: 1,
        idempotencyKey: "key-race-b",
      })) as Promise<{state: string}>;

      const secondResult = await secondCall;
      unblock();
      const firstResult = await firstCall;

      const states = [firstResult.state, secondResult.state].sort();
      assert.deepEqual(states, ["done", "failed"]);
      assert.equal(
        send.mock.calls.filter(
          (c) => c.arguments[0].command === "domain:renew",
        ).length,
        1,
      );
    },
  );
});
