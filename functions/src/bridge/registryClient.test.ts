import assert from "node:assert/strict";
import {afterEach, describe, it, mock} from "node:test";

import {EppClient} from "./eppClient";
import type {EppRequest, EppSuccess} from "./eppClient.js";
import {KitaqnicClient} from "./kitaqnicClient";
import {KitaqsignClient} from "./kitaqsignClient.js";
import type {RegistryClient} from "./registryClient";
import {EPP_RESULT} from "./types";
import type {
  ContactResponse,
  DomainInfoWire,
  DomainRenewRequest,
  DomainTransferResponse,
  HostInfoWire,
} from "./types.js";

/**
 * Stands in for `EppClient`: records every request it is asked to send and
 * answers with the next queued canned response.
 *
 * Injected directly onto the client's protected `http` field, bypassing the
 * real HTTP transport and RegistryLog write entirely — this test only needs
 * to assert on the request BaseRegistryClient built, not on network or
 * Firestore behaviour (both already exercised elsewhere).
 */
class FakeEppClient {
  readonly calls: EppRequest[] = [];
  private readonly queue: Array<() => EppSuccess<unknown>> = [];

  /**
   * Queues one canned answer for the next `send` call.
   *
   * @param {function(): EppSuccess<unknown>} factory Builds the answer.
   * @return {void}
   */
  enqueue(factory: () => EppSuccess<unknown>): void {
    this.queue.push(factory);
  }

  /**
   * Records the request and returns the next queued answer.
   *
   * @param {EppRequest} request Command the caller wants to run.
   * @return {Promise<EppSuccess<T>>} The queued canned answer.
   * @template T
   */
  async send<T>(request: EppRequest): Promise<EppSuccess<T>> {
    this.calls.push(request);
    const factory = this.queue.shift();
    if (!factory) {
      throw new Error(
        "FakeEppClient: no response queued for " + request.command,
      );
    }
    return factory() as EppSuccess<T>;
  }
}

/**
 * Builds a canned successful `EppSuccess` answer.
 *
 * @param {T} resData Payload to return as `resData`.
 * @param {Partial<EppSuccess<T>>} overrides Fields to override.
 * @return {EppSuccess<T>} The canned answer.
 * @template T
 */
function success<T>(
  resData?: T,
  overrides: Partial<EppSuccess<T>> = {},
): EppSuccess<T> {
  return {
    httpStatus: 200,
    resultCode: 1000,
    resData,
    clTRID: "TEST-CLTRID",
    svTRID: "SV-1",
    tolerated: false,
    ...overrides,
  };
}

/** Client under test paired with the fake transport injected into it. */
interface TestClient {
  client: KitaqsignClient;
  http: FakeEppClient;
}

/**
 * Builds a client with a `FakeEppClient` injected in place of the real HTTP
 * transport.
 *
 * @return {TestClient} The client and the fake transport it now uses.
 */
function buildClient(): TestClient {
  const client = new KitaqsignClient();
  const http = new FakeEppClient();
  (client as unknown as {http: unknown}).http = http;
  return {client, http};
}

describe("updateDomain (existing contract, regression)", () => {
  it("PUTs /domains/{name}, non-idempotent, body passed through", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));

    await client.updateDomain(
      "example.com",
      {add: {nameservers: ["ns1.example.com"]}},
      "CLTRID-1",
      {uid: "u-1", orderId: "o-1"},
    );

    assert.equal(http.calls.length, 1);
    const call = http.calls[0];
    assert.equal(call.command, "domain:update");
    assert.equal(call.method, "PUT");
    assert.equal(call.path, "/domains/example.com");
    assert.deepEqual(call.body, {add: {nameservers: ["ns1.example.com"]}});
    assert.equal(call.idempotent, false);
    assert.equal(call.clTRID, "CLTRID-1");
    assert.equal(call.uid, "u-1");
    assert.equal(call.orderId, "o-1");
  });

  it("URL-encodes the domain name in the path", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));
    await client.updateDomain("a b.com", {}, "CLTRID-2");
    assert.equal(http.calls[0].path, "/domains/a%20b.com");
  });
});

describe("infoDomain secDns pass-through", () => {
  it("carries recognised secDNS dsData into DomainInfo", async () => {
    const {client, http} = buildClient();
    const wire: DomainInfoWire = {
      domain: "example.com",
      status: ["ok"],
      registrant: "c-1",
      contacts: {},
      nameservers: [],
      crDate: "2026-01-01T00:00:00Z",
      rgpStatus: [],
      extensions: {
        secDNS: {
          dsData: [
            {keyTag: 1, algorithm: 8, digestType: 2, digest: "a".repeat(64)},
          ],
        },
      },
    };
    http.enqueue(() => success(wire));

    const info = await client.infoDomain("example.com", "CLTRID-3");
    assert.equal(http.calls[0].method, "GET");
    assert.equal(http.calls[0].idempotent, true);
    assert.deepEqual(info.secDns, [
      {keyTag: 1, algorithm: 8, digestType: 2, digest: "a".repeat(64)},
    ]);
  });

  it("leaves secDns undefined without an extension", async () => {
    const {client, http} = buildClient();
    const wire: DomainInfoWire = {
      domain: "example.com",
      status: [],
      registrant: "c-1",
      contacts: {},
      nameservers: [],
      crDate: "2026-01-01T00:00:00Z",
      rgpStatus: [],
    };
    http.enqueue(() => success(wire));
    const info = await client.infoDomain("example.com", "CLTRID-4");
    assert.equal(info.secDns, undefined);
  });
});

describe("infoContact", () => {
  it("GETs /contacts/{id}, idempotent, normalises the answer", async () => {
    const {client, http} = buildClient();
    const wire: ContactResponse = {
      id: "c-1",
      postalInfo: {
        name: "Taro Test",
        addr: {street: "1 Test St", city: "Tokyo", cc: "JP"},
      },
      voice: "+81.312345678",
      email: "member@example.com",
      status: ["ok"],
      crDate: "2026-01-01T00:00:00Z",
    };
    http.enqueue(() => success(wire));

    const info = await client.infoContact("c-1", "CLTRID-5");

    assert.equal(http.calls[0].command, "contact:info");
    assert.equal(http.calls[0].method, "GET");
    assert.equal(http.calls[0].path, "/contacts/c-1");
    assert.equal(http.calls[0].idempotent, true);
    assert.equal(info.contactId, "c-1");
    assert.equal(info.email, "member@example.com");
    assert.equal(info.registry, "kitaqsign");
  });
});

describe("updateContact", () => {
  it("PUTs /contacts/{id}, non-idempotent, chg passed through", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));

    await client.updateContact(
      "c-1",
      {chg: {voice: "+81.312345678"}},
      "CLTRID-6",
      {uid: "u-1"},
    );

    const call = http.calls[0];
    assert.equal(call.command, "contact:update");
    assert.equal(call.method, "PUT");
    assert.equal(call.path, "/contacts/c-1");
    assert.deepEqual(call.body, {chg: {voice: "+81.312345678"}});
    assert.equal(call.idempotent, false);
    assert.equal(call.uid, "u-1");
  });

  it("never carries an authInfo field on the wire body", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));
    await client.updateContact(
      "c-1",
      {chg: {email: "member@example.com"}},
      "CLTRID-7",
    );
    const body = http.calls[0].body as Record<string, unknown>;
    assert.equal(JSON.stringify(body).includes("authInfo"), false);
  });
});

describe("createHost", () => {
  it("POSTs /hosts, non-idempotent, never tolerates 2302", async () => {
    const {client, http} = buildClient();
    const wire: HostInfoWire = {
      name: "ns1.example.com",
      addrs: [{addr: "192.0.2.1", ip: "v4"}],
      status: ["ok"],
      crDate: "2026-01-01T00:00:00Z",
    };
    http.enqueue(() => success(wire));

    const outcome = await client.createHost(
      {
        name: "ns1.example.com",
        addrs: [{addr: "192.0.2.1", ip: "v4"}],
      },
      "CLTRID-8",
      {uid: "u-1"},
    );

    const call = http.calls[0];
    assert.equal(call.command, "host:create");
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/hosts");
    assert.equal(call.idempotent, false);
    // 2302 must never be tolerated: an existing host is never silently
    // adopted into caller ownership (architecture decision).
    assert.equal(call.tolerate, undefined);
    assert.equal(outcome.name, "ns1.example.com");
    assert.equal(outcome.registry, "kitaqsign");
  });
});

describe("infoHost", () => {
  it("GETs /hosts/{name}, idempotent, normalises the answer", async () => {
    const {client, http} = buildClient();
    const wire: HostInfoWire = {
      name: "ns1.example.com",
      addrs: [
        {addr: "192.0.2.1", ip: "v4"},
        {addr: "2001:db8::1", ip: "v6"},
      ],
      status: ["ok"],
      crDate: "2026-01-01T00:00:00Z",
      upDate: null,
    };
    http.enqueue(() => success(wire));

    const info = await client.infoHost("ns1.example.com", "CLTRID-9");

    assert.equal(http.calls[0].command, "host:info");
    assert.equal(http.calls[0].method, "GET");
    assert.equal(http.calls[0].path, "/hosts/ns1.example.com");
    assert.equal(http.calls[0].idempotent, true);
    assert.equal(info.addresses.length, 2);
    assert.equal(info.name, "ns1.example.com");
  });
});

describe("updateHost", () => {
  it("PUTs /hosts/{name}, non-idempotent, add/rem passed through", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));

    await client.updateHost(
      "ns1.example.com",
      {
        add: {addrs: [{addr: "192.0.2.2", ip: "v4"}]},
        rem: {addrs: [{addr: "192.0.2.1", ip: "v4"}]},
      },
      "CLTRID-10",
      {uid: "u-1"},
    );

    const call = http.calls[0];
    assert.equal(call.command, "host:update");
    assert.equal(call.method, "PUT");
    assert.equal(call.path, "/hosts/ns1.example.com");
    assert.deepEqual(call.body, {
      add: {addrs: [{addr: "192.0.2.2", ip: "v4"}]},
      rem: {addrs: [{addr: "192.0.2.1", ip: "v4"}]},
    });
    assert.equal(call.idempotent, false);
  });
});

const RENEW_RESPONSE = {
  httpStatus: 200,
  resultCode: EPP_RESULT.SUCCESS,
  resData: {domain: "example.com", exDate: "2028-05-05"},
  extension: undefined,
  clTRID: "ORD-000001-RENEW-01",
  svTRID: "SV-1",
  tolerated: false,
};

const RENEW_REQUEST: DomainRenewRequest = {
  curExpDate: "2027-05-05",
  period: {unit: "Y", value: 1},
};

afterEach(() => {
  mock.restoreAll();
});

describe("renewDomain", () => {
  const clients: Array<{name: string; client: RegistryClient}> = [
    {name: "KitaqsignClient", client: new KitaqsignClient()},
    {name: "KitaqnicClient", client: new KitaqnicClient()},
  ];

  for (const {name, client} of clients) {
    it(`normalises ${name}'s response into a DomainRenewOutcome`, async () => {
      const send = mock.method(
        EppClient.prototype,
        "send",
        async () => RENEW_RESPONSE,
      );

      const outcome = await client.renewDomain(
        "example.com",
        RENEW_REQUEST,
        "ORD-000001-RENEW-01",
        {uid: "uid-1", orderId: "order-1"},
      );

      assert.deepEqual(outcome, {
        domain: "example.com",
        registry: client.registry,
        exDate: "2028-05-05",
        clTRID: "ORD-000001-RENEW-01",
        svTRID: "SV-1",
      });

      assert.equal(send.mock.calls.length, 1);
      const call = send.mock.calls[0];
      assert.equal(call.arguments.length, 1);
      assert.deepEqual(call.arguments[0], {
        command: "domain:renew",
        method: "POST",
        path: "/domains/example.com/renew",
        body: RENEW_REQUEST,
        clTRID: "ORD-000001-RENEW-01",
        idempotent: false,
        uid: "uid-1",
        orderId: "order-1",
      });
      assert.equal("tolerate" in call.arguments[0], false);
    });
  }

  it("URL-encodes the domain name in the request path", async () => {
    const send = mock.method(
      EppClient.prototype,
      "send",
      async () => RENEW_RESPONSE,
    );
    const client = new KitaqsignClient();

    await client.renewDomain(
      "exämple.com",
      RENEW_REQUEST,
      "ORD-000001-RENEW-01",
    );

    const call = send.mock.calls[0];
    assert.equal(
      (call.arguments[0] as {path: string}).path,
      `/domains/${encodeURIComponent("exämple.com")}/renew`,
    );
  });

  it("omits uid/orderId from the request when no context is given",
    async () => {
      const send = mock.method(
        EppClient.prototype,
        "send",
        async () => RENEW_RESPONSE,
      );
      const client = new KitaqnicClient();

      await client.renewDomain(
        "example.com",
        RENEW_REQUEST,
        "ORD-000001-RENEW-01",
      );

      const call = send.mock.calls[0];
      const request = call.arguments[0] as {
      uid?: string;
      orderId?: string;
    };
      assert.equal(request.uid, undefined);
      assert.equal(request.orderId, undefined);
    });
});

// --- domain:transfer (spec 6.6) -------------------------------------------

/** Kitaqnic's fuller shape; Kitaqsign omits reDate/acDate (spec 3.8). */
const TRANSFER_RES_DATA: DomainTransferResponse = {
  domain: "example.com",
  status: "pending",
  gainingRegistrar: "KITAQ-US",
  losingRegistrar: "KITAQ-THEM",
  reDate: "2026-08-26T10:00:00Z",
};

describe("requestTransfer", () => {
  it("POSTs .../transfer/request with op=request and the authInfo",
    async () => {
      const {client, http} = buildClient();
      http.enqueue(() => success(TRANSFER_RES_DATA, {
        httpStatus: 202,
        resultCode: EPP_RESULT.SUCCESS_ACTION_PENDING,
      }));

      const outcome = await client.requestTransfer(
        "example.com",
        {op: "request", authInfo: "s3cr3t-pass"},
        "DOM-TRANSFER-EXAMPLE-COM-REQUEST-1",
        {uid: "u-1"},
      );

      const call = http.calls[0];
      assert.equal(call.command, "domain:transfer request");
      assert.equal(call.method, "POST");
      assert.equal(call.path, "/domains/example.com/transfer/request");
      assert.deepEqual(call.body, {op: "request", authInfo: "s3cr3t-pass"});
      // Never retried: a re-send could raise a second live transfer.
      assert.equal(call.idempotent, false);
      assert.equal(call.tolerate, undefined);
      assert.equal(call.uid, "u-1");

      assert.equal(outcome.domain, "example.com");
      assert.equal(outcome.registry, "kitaqsign");
      assert.equal(outcome.status, "pending");
      assert.equal(outcome.gainingRegistrar, "KITAQ-US");
      assert.equal(outcome.losingRegistrar, "KITAQ-THEM");
      assert.equal(outcome.requestedAt, "2026-08-26T10:00:00Z");
      assert.equal(outcome.actionedAt, null);
    });

  it("never sends a period, so the registry decides the term", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(TRANSFER_RES_DATA));
    await client.requestTransfer(
      "example.com",
      {op: "request", authInfo: "s3cr3t-pass"},
      "CLTRID-T1",
    );
    assert.equal("period" in (http.calls[0].body as object), false);
  });

  it("URL-encodes the domain name in the path", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(TRANSFER_RES_DATA));
    await client.requestTransfer(
      "exämple.com",
      {op: "request", authInfo: "p"},
      "CLTRID-T2",
    );
    assert.equal(
      http.calls[0].path,
      `/domains/${encodeURIComponent("exämple.com")}/transfer/request`,
    );
  });
});

describe("approveTransfer / rejectTransfer / cancelTransfer", () => {
  const operations = [
    {name: "approveTransfer", path: "approve"},
    {name: "rejectTransfer", path: "reject"},
    {name: "cancelTransfer", path: "cancel"},
  ] as const;

  for (const {name, path} of operations) {
    it(`${name} POSTs .../transfer/${path} with no body`, async () => {
      const {client, http} = buildClient();
      http.enqueue(() => success({...TRANSFER_RES_DATA, status: path}));

      const outcome = await client[name](
        "example.com",
        `CLTRID-${path}`,
        {uid: "u-1"},
      );

      const call = http.calls[0];
      assert.equal(call.command, `domain:transfer ${path}`);
      assert.equal(call.method, "POST");
      assert.equal(call.path, `/domains/example.com/transfer/${path}`);
      // The OpenAPI documents no request body for these three endpoints; the
      // path already says which operation is meant.
      assert.equal(call.body, undefined);
      assert.equal(call.idempotent, false);
      assert.equal(outcome.status, path);
    });
  }
});

describe("transfer answers that carry no resData", () => {
  it("fails loudly rather than inventing a transfer state", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));
    await assert.rejects(
      client.approveTransfer("example.com", "CLTRID-T3"),
      /returned no resData/,
    );
  });
});

// --- domain:rotate authInfo (spec 3.9) ------------------------------------

describe("rotateAuthInfo", () => {
  it("POSTs .../rotate-auth-info with no body and returns the new code",
    async () => {
      const {client, http} = buildClient();
      http.enqueue(() => success({authInfo: "fresh-pass-phrase"}));

      const outcome = await client.rotateAuthInfo(
        "example.com",
        "DOM-ROTATE-EXAMPLE-COM-1",
        {uid: "u-1"},
      );

      const call = http.calls[0];
      assert.equal(call.command, "domain:rotate authInfo");
      assert.equal(call.method, "POST");
      assert.equal(call.path, "/domains/example.com/rotate-auth-info");
      // The endpoint documents no request body — the path says everything.
      assert.equal(call.body, undefined);
      assert.equal(call.uid, "u-1");

      assert.equal(outcome.domain, "example.com");
      assert.equal(outcome.registry, "kitaqsign");
      assert.equal(outcome.authInfo, "fresh-pass-phrase");
      assert.equal(outcome.svTRID, "SV-1");
    });

  it("is never declared idempotent, so a timeout cannot mint a second code",
    async () => {
      // A retry would replace the passphrase the first attempt handed to the
      // member, and nothing can read an authInfo back to notice.
      const {client, http} = buildClient();
      http.enqueue(() => success({authInfo: "p"}));
      await client.rotateAuthInfo("example.com", "CLTRID-R1");
      assert.equal(http.calls[0].idempotent, false);
      assert.equal(http.calls[0].tolerate, undefined);
    });

  it("URL-encodes the domain name in the path", async () => {
    const {client, http} = buildClient();
    http.enqueue(() => success({authInfo: "p"}));
    await client.rotateAuthInfo("exämple.com", "CLTRID-R2");
    assert.equal(
      http.calls[0].path,
      `/domains/${encodeURIComponent("exämple.com")}/rotate-auth-info`,
    );
  });

  it("works the same way on Kitaqnic", async () => {
    // The two documents differ only in the Java type printed for the payload
    // (spec 3.8 差分表); the path, the body and the field are identical, so
    // BRIDGE has one implementation rather than two.
    const client = new KitaqnicClient();
    const http = new FakeEppClient();
    (client as unknown as {http: unknown}).http = http;
    http.enqueue(() => success({authInfo: "nic-pass"}));

    const outcome = await client.rotateAuthInfo("example.shop", "CLTRID-R3");

    assert.equal(http.calls[0].path,
      "/domains/example.shop/rotate-auth-info");
    assert.equal(outcome.registry, "kitaqnic");
    assert.equal(outcome.authInfo, "nic-pass");
  });

  it("refuses an answer with no usable authInfo", async () => {
    // `authInfo` is required by both schemas. An answer without one means the
    // old passphrase may already be dead while we have nothing to hand over,
    // which must not be reported as success.
    const {client, http} = buildClient();
    http.enqueue(() => success(undefined));
    await assert.rejects(
      client.rotateAuthInfo("example.com", "CLTRID-R4"),
      /returned no authInfo/,
    );
  });

  it("refuses an answer whose authInfo is not a string", async () => {
    // Kitaqnic's schema was read as `Map<String,Object>` at one point, so a
    // non-string value is a shape this client has to survive.
    const {client, http} = buildClient();
    http.enqueue(() => success({authInfo: 42 as unknown as string}));
    await assert.rejects(
      client.rotateAuthInfo("example.com", "CLTRID-R5"),
      /returned no authInfo/,
    );
  });
});
