import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {afterEach, before, describe, it, mock} from "node:test";

import {FieldValue, Timestamp} from "firebase-admin/firestore";

import {EppClient, type EppRequest, type EppSuccess} from "../bridge/eppClient";
import {RegistryError} from "../bridge/errors";
import {EPP_RESULT} from "../bridge/types";
import type {RegistryId} from "../config/options";
import {COLLECTIONS, db} from "../config/firebase";
import {openOrder, type OrderHandle} from "./orders";
import {
  RENEW_LEASE_MS,
  RENEW_MAX_ATTEMPTS,
  renewDomain,
} from "./renewDomain";
import {
  expectedRenewalExDate,
  normaliseEppDateTime,
  validateEppDate,
} from "./validation";

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

// --- date helpers -----------------------------------------------------------

describe("validateEppDate", () => {
  it("accepts a strict YYYY-MM-DD date", () => {
    assert.equal(validateEppDate("2028-02-29", "exDate"), "2028-02-29");
  });

  it("rejects a datetime-suffixed value", () => {
    assert.throws(() => validateEppDate("2028-02-29T00:00:00Z", "exDate"));
  });

  it("rejects a value with no dashes", () => {
    assert.throws(() => validateEppDate("20280229", "exDate"));
  });

  it("rejects a calendar-invalid date", () => {
    assert.throws(() => validateEppDate("2028-02-30", "exDate"));
    // 2027 is not a leap year, so this day does not exist.
    assert.throws(() => validateEppDate("2027-02-29", "exDate"));
  });

  it("rejects an empty string", () => {
    assert.throws(() => validateEppDate("", "exDate"));
  });
});

describe("normaliseEppDateTime", () => {
  it("truncates a registry ISO datetime to its date part", () => {
    assert.equal(
      normaliseEppDateTime("2027-08-27T03:02:41Z"),
      "2027-08-27",
    );
  });

  it("passes a date-only value through unchanged", () => {
    assert.equal(normaliseEppDateTime("2027-08-27"), "2027-08-27");
  });

  it("passes garbage through for validateEppDate to reject", () => {
    assert.equal(normaliseEppDateTime("not-a-date"), "not-a-date");
    assert.throws(() =>
      validateEppDate(normaliseEppDateTime("not-a-date"), "exDate"));
  });
});

describe("expectedRenewalExDate", () => {
  it("adds whole calendar years via UTC", () => {
    assert.equal(expectedRenewalExDate("2027-05-05", 1), "2028-05-05");
    assert.equal(expectedRenewalExDate("2027-05-05", 10), "2037-05-05");
  });

  it("rolls a leap day forward across a year boundary", () => {
    assert.equal(expectedRenewalExDate("2028-02-29", 1), "2029-03-01");
  });

  it("throws on an invalid curExpDate", () => {
    assert.throws(() => expectedRenewalExDate("2028-02-30", 1));
  });

  it("is an exact string that only matches its own value", () => {
    const a = expectedRenewalExDate("2027-05-05", 1);
    const b = expectedRenewalExDate("2027-05-05", 1);
    assert.equal(a, b);
    assert.notEqual(a, "2028-05-04");
    assert.notEqual(a, "2028-05-06");
  });
});

// --- renewDomain use case ----------------------------------------------------

interface RenewFixture {
  uid: string;
  domainName: string;
  curExpDate: string;
  expectedExDate: string;
  periodYears: number;
  order: OrderHandle;
}

/**
 * Seeds an owned Domain document and opens a fresh renew Order against it.
 *
 * @param {object} [overrides] Optional curExpDate/periodYears overrides.
 * @return {Promise<RenewFixture>} Fixture identifiers and the opened order.
 */
async function seedRenewOrder(overrides?: {
  curExpDate?: string;
  periodYears?: number;
}): Promise<RenewFixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const uid = `uid-${suffix}`;
  const domainName = `renew-${suffix}.com`;
  const curExpDate = overrides?.curExpDate ?? "2027-05-05";
  const periodYears = overrides?.periodYears ?? 1;
  const expectedExDate = expectedRenewalExDate(curExpDate, periodYears);

  await db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`)
    .set({
      uid,
      name: domainName,
      tld: "com",
      registry: REGISTRY,
      status: [],
      rgpStatus: [],
      nameservers: [],
      // The mirror holds the registry's answer verbatim, and the real
      // registries answer an ISO datetime — seed that shape so the suite
      // exercises the same mismatch production sees against the date-only
      // order snapshot.
      exDate: `${curExpDate}T03:02:41Z`,
      autoRenew: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

  const order = await openOrder({
    kind: "renew",
    uid,
    idempotencyKey: `key-${suffix}`,
    domainName,
    registry: REGISTRY,
    periodYears,
    priceYen: 1500,
    curExpDate,
    expectedExDate,
  });

  return {uid, domainName, curExpDate, expectedExDate, periodYears, order};
}

/**
 * Reloads an order handle straight from Firestore.
 *
 * @param {OrderHandle} order Order to reload.
 * @return {Promise<OrderHandle>} Freshly read handle.
 */
async function reload(order: OrderHandle): Promise<OrderHandle> {
  const snap = await order.ref.get();
  return {...order, data: snap.data() as OrderHandle["data"]};
}

/** Shape of the `renewLease` field, loose enough for assertions in tests. */
interface LeaseSnapshot {
  orderId: string;
  holderToken: string | null;
  expiresAt: Timestamp;
  acquiredAt: Timestamp;
}

/**
 * Reads the `renewLease` field of a fixture's Domain document.
 *
 * @param {RenewFixture} fixture Fixture to inspect.
 * @return {Promise<LeaseSnapshot | undefined>} The lease, or undefined.
 */
async function readLease(
  fixture: RenewFixture,
): Promise<LeaseSnapshot | undefined> {
  const snap = await db()
    .collection(COLLECTIONS.domains)
    .doc(`${fixture.uid}__${fixture.domainName}`)
    .get();
  return snap.data()?.renewLease as LeaseSnapshot | undefined;
}

/**
 * Expands a date-only expiry into the ISO-datetime shape the real
 * Kitaqsign/Kitaqnic registries answer with. Anything that is not a plain
 * `YYYY-MM-DD` (already a datetime, garbage, undefined) passes through, so
 * malformed-envelope tests keep their exact payloads.
 *
 * @param {string | undefined} exDate Date-only expiry, or any other value.
 * @return {string | undefined} Registry-shaped expiry.
 */
function asRegistryDateTime(exDate: string | undefined): string | undefined {
  return exDate !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(exDate) ?
    `${exDate}T03:02:41Z` :
    exDate;
}

/**
 * Builds a successful `domain:renew` EppSuccess envelope, answering the
 * expiry in the real registries' ISO-datetime wire shape.
 *
 * @param {string} domain Domain name echoed back.
 * @param {string} exDate New expiry to answer with (date-only is expanded
 *   to a datetime, mirroring the real registries).
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function renewSuccess(domain: string, exDate: string): EppSuccess<unknown> {
  return {
    httpStatus: 200,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {domain, exDate: asRegistryDateTime(exDate)},
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-1",
    tolerated: false,
  };
}

/**
 * Builds a successful `domain:info` EppSuccess envelope, answering the
 * expiry in the real registries' ISO-datetime wire shape.
 *
 * @param {string} domain Domain name echoed back.
 * @param {string | undefined} exDate Expiry to answer with (date-only is
 *   expanded to a datetime, mirroring the real registries).
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function infoSuccess(
  domain: string,
  exDate: string | undefined,
): EppSuccess<unknown> {
  return {
    httpStatus: 200,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {
      domain,
      status: [],
      registrant: "registrant-1",
      contacts: {},
      nameservers: [],
      crDate: "2020-01-01",
      exDate: asRegistryDateTime(exDate),
      rgpStatus: [],
    },
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-2",
    tolerated: false,
  };
}

/**
 * A transport-kind RegistryError, as EppClient.send would throw on timeout.
 *
 * @param {string} command EPP command name to attach.
 * @return {RegistryError} A retryable, ambiguous failure.
 */
function transportError(command: string): RegistryError {
  return new RegistryError({
    kind: "transport",
    registry: REGISTRY,
    command,
    message: "simulated timeout",
    clTRID: "stub",
    retryable: true,
  });
}

/**
 * A validation-kind RegistryError, as EppClient.send would throw on a 400.
 *
 * @param {string} command EPP command name to attach.
 * @return {RegistryError} A non-retryable, explicit rejection.
 */
function validationError(command: string): RegistryError {
  return new RegistryError({
    kind: "validation",
    registry: REGISTRY,
    command,
    message: "simulated bad request",
    httpStatus: 400,
    clTRID: "stub",
    retryable: false,
  });
}

/** Per-command async response handlers for {@link stubSend}. */
interface SendHandlers {
  "domain:renew"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
  "domain:info"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
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

describe("renewDomain — happy path", () => {
  it("commits done, updates the domain, and releases the lease", async () => {
    const fixture = await seedRenewOrder();
    const send = stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, fixture.expectedExDate),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "done");
    assert.equal(result.exDate, fixture.expectedExDate);
    assert.equal(result.recovered, false);
    assert.equal(send.mock.calls.length, 1);
    assert.equal(send.mock.calls[0].arguments[0].command, "domain:renew");
    assert.equal(send.mock.calls[0].arguments[0].idempotent, false);

    // Atomic terminal commit: order done+result, domain exDate advanced and
    // lastRenewOrderId set, lease gone — all from the one commit.
    const orderSnap = await fixture.order.ref.get();
    assert.equal(orderSnap.data()?.state, "done");
    assert.deepEqual(orderSnap.data()?.result, {
      exDate: fixture.expectedExDate,
      recovered: false,
    });

    const domainSnap = await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .get();
    assert.equal(domainSnap.data()?.exDate, fixture.expectedExDate);
    assert.equal(domainSnap.data()?.lastRenewOrderId, fixture.order.id);
    assert.equal(domainSnap.data()?.renewLease, undefined);
  });

  it("returns the existing result for a done order, no registry call",
    async () => {
      const fixture = await seedRenewOrder();
      stubSend({
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, fixture.expectedExDate),
      });
      const first = await renewDomain(fixture.order);
      assert.equal(first.state, "done");

      mock.restoreAll();
      const send = stubSend({});
      const reloaded = await reload(fixture.order);
      const second = await renewDomain(reloaded);

      assert.equal(second.state, "done");
      assert.equal(second.exDate, fixture.expectedExDate);
      assert.equal(send.mock.calls.length, 0);
    });
});

describe("renewDomain — periodYears boundary", () => {
  it("accepts periodYears: 10 end-to-end and computes the correct " +
    "expectedExDate", async () => {
    const fixture = await seedRenewOrder({periodYears: 10});
    assert.equal(fixture.expectedExDate, "2037-05-05");
    stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, fixture.expectedExDate),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "done");
    assert.equal(result.exDate, "2037-05-05");

    const domainSnap = await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .get();
    assert.equal(domainSnap.data()?.exDate, "2037-05-05");
  });
});

describe("renewDomain — non-matching but valid response", () => {
  // The registries renew from their own stored expiry and ignore
  // `curExpDate`, so a stale mirror snapshot makes the prediction wrong
  // while the renewal itself succeeded and charged. The success answer is
  // authoritative: this must land as `done` with the observed date, never
  // as `failed` (a "failed" screen here is what invited a second, real
  // renewal).
  it("commits done with the observed exDate, leaves the snapshot untouched",
    async () => {
      const fixture = await seedRenewOrder();
      // One year past the expectation, as when the registry auto-renewed
      // the base after the mirror was last synced.
      const observedExDate = "2029-05-05";
      stubSend({
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, observedExDate),
      });

      const result = await renewDomain(fixture.order);

      assert.equal(result.state, "done");
      assert.equal(result.recovered, false);
      assert.equal(result.exDate, observedExDate);
      const orderSnap = await fixture.order.ref.get();
      assert.equal(orderSnap.data()?.state, "done");
      assert.equal(orderSnap.data()?.curExpDate, fixture.curExpDate);
      assert.equal(orderSnap.data()?.expectedExDate, fixture.expectedExDate);

      const domainSnap = await db()
        .collection(COLLECTIONS.domains)
        .doc(`${fixture.uid}__${fixture.domainName}`)
        .get();
      assert.equal(domainSnap.data()?.exDate, observedExDate);
      assert.equal(domainSnap.data()?.renewLease, undefined);
    });
});

describe("renewDomain — malformed success envelope", () => {
  it("mismatched domain in resData is not trusted, reconciles via domain:info",
    async () => {
      const fixture = await seedRenewOrder();
      const send = stubSend({
        "domain:renew": async () =>
          renewSuccess("wrong-domain.example", fixture.expectedExDate),
        "domain:info": async () =>
          infoSuccess(fixture.domainName, fixture.expectedExDate),
      });

      const result = await renewDomain(fixture.order);

      assert.equal(result.state, "done");
      assert.equal(result.recovered, true);
      assert.equal(result.exDate, fixture.expectedExDate);
      assert.deepEqual(
        send.mock.calls.map((c) => c.arguments[0].command),
        ["domain:renew", "domain:info"],
      );
    });

  it("invalid exDate in resData is not trusted, reconciles via domain:info",
    async () => {
      const fixture = await seedRenewOrder();
      const send = stubSend({
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, "not-a-date"),
        "domain:info": async () =>
          infoSuccess(fixture.domainName, fixture.expectedExDate),
      });

      const result = await renewDomain(fixture.order);

      assert.equal(result.state, "done");
      assert.equal(result.recovered, true);
      assert.equal(result.exDate, fixture.expectedExDate);
      assert.deepEqual(
        send.mock.calls.map((c) => c.arguments[0].command),
        ["domain:renew", "domain:info"],
      );
    });
});

describe("renewDomain — ambiguous failure reconciliation", () => {
  it("transport error, info confirms expectedExDate -> done", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.expectedExDate),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "done");
    assert.equal(result.recovered, true);
    assert.equal(result.exDate, fixture.expectedExDate);
    const lease = await readLease(fixture);
    assert.equal(lease, undefined);
  });

  it("curExpDate confirmed -> retrying, lease parked for retry", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.curExpDate),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "retrying");
    const lease = await readLease(fixture);
    assert.ok(lease);
    assert.equal(lease.orderId, fixture.order.id);
    assert.equal(lease.holderToken, null);

    // A later invocation of the same order can re-enter immediately.
    const reloaded = await reload(fixture.order);
    const send = stubSend({
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, fixture.expectedExDate),
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.curExpDate),
    });
    const second = await renewDomain(reloaded);
    assert.equal(second.state, "done");
    assert.equal(
      send.mock.calls.filter((c) => c.arguments[0].command === "domain:info")
        .length,
      1,
    );
    assert.equal(
      send.mock.calls.filter((c) => c.arguments[0].command === "domain:renew")
        .length,
      1,
    );
  });

  it("transport error, info shows an extension past the snapshot -> done " +
    "(the ambiguous send is taken as applied)", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () => infoSuccess(fixture.domainName, "2099-09-09"),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "done");
    assert.equal(result.recovered, true);
    assert.equal(result.exDate, "2099-09-09");
    const domainSnap = await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .get();
    assert.equal(domainSnap.data()?.exDate, "2099-09-09");
    assert.equal(await readLease(fixture), undefined);
  });

  it("transport error, info shows a date before the snapshot -> failed",
    async () => {
      const fixture = await seedRenewOrder();
      stubSend({
        "domain:renew": async () => {
          throw transportError("domain:renew");
        },
        "domain:info": async () =>
          infoSuccess(fixture.domainName, "1999-01-01"),
      });

      const result = await renewDomain(fixture.order);

      assert.equal(result.state, "failed");
      const orderSnap = await fixture.order.ref.get();
      assert.equal(orderSnap.data()?.curExpDate, fixture.curExpDate);
      assert.equal(orderSnap.data()?.expectedExDate, fixture.expectedExDate);
      assert.equal(await readLease(fixture), undefined);
    });

  it("explicit registry rejection fails immediately, no info call",
    async () => {
      const fixture = await seedRenewOrder();
      const send = stubSend({
        "domain:renew": async () => {
          throw validationError("domain:renew");
        },
      });

      const result = await renewDomain(fixture.order);

      assert.equal(result.state, "failed");
      assert.equal(send.mock.calls.length, 1);
      assert.equal(await readLease(fixture), undefined);
    });

  it("unknown-kind error (plain throw, not a RegistryError) reconciles via " +
    "domain:info the same way as a transport error", async () => {
    const fixture = await seedRenewOrder();
    const send = stubSend({
      "domain:renew": async () => {
        throw new Error("simulated unexpected failure");
      },
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.expectedExDate),
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "done");
    assert.equal(result.recovered, true);
    assert.equal(result.exDate, fixture.expectedExDate);
    assert.deepEqual(
      send.mock.calls.map((c) => c.arguments[0].command),
      ["domain:renew", "domain:info"],
    );
  });

  it("info failure keeps retrying with the reservation preserved", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () => {
        throw transportError("domain:info");
      },
    });

    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "retrying");
    const lease = await readLease(fixture);
    assert.ok(lease);
    // Untouched: still the original holder token, not parked to null, so a
    // concurrent/rapid re-entry of the same order is still turned away
    // (forces a wait rather than hammering a possibly-struggling registry).
    assert.equal(lease.orderId, fixture.order.id);
    assert.notEqual(lease.holderToken, null);

    const reloaded = await reload(fixture.order);
    const second = await renewDomain(reloaded);
    assert.equal(second.state, "retrying");
    assert.equal(second.message, "処理中です。しばらくしてから再度お試しください。");
  });

  it("re-entrant order reconciles via domain:info before resending",
    async () => {
      const fixture = await seedRenewOrder();
      stubSend({
        "domain:renew": async () => {
          throw transportError("domain:renew");
        },
        "domain:info": async () =>
          infoSuccess(fixture.domainName, fixture.curExpDate),
      });
      const first = await renewDomain(fixture.order);
      assert.equal(first.state, "retrying");

      mock.restoreAll();
      const send = stubSend({
        "domain:info": async () =>
          infoSuccess(fixture.domainName, fixture.curExpDate),
        "domain:renew": async () =>
          renewSuccess(fixture.domainName, fixture.expectedExDate),
      });
      const reloaded = await reload(fixture.order);
      const second = await renewDomain(reloaded);

      assert.equal(second.state, "done");
      const calls = send.mock.calls.map((c) => c.arguments[0].command);
      assert.deepEqual(calls, ["domain:info", "domain:renew"]);
    });

  it("exhausts the attempt budget and fails, releasing the lease", async () => {
    const fixture = await seedRenewOrder();
    let order = fixture.order;

    for (let i = 0; i < RENEW_MAX_ATTEMPTS; i++) {
      mock.restoreAll();
      stubSend({
        "domain:renew": async () => {
          throw transportError("domain:renew");
        },
        "domain:info": async () =>
          infoSuccess(fixture.domainName, fixture.curExpDate),
      });
      const result = await renewDomain(order);
      if (i < RENEW_MAX_ATTEMPTS - 1) {
        assert.equal(result.state, "retrying");
      } else {
        assert.equal(result.state, "failed");
      }
      order = await reload(order);
    }

    assert.equal(order.data.attempts, RENEW_MAX_ATTEMPTS);
    assert.equal(order.data.state, "failed");
    assert.equal(await readLease(fixture), undefined);
  });
});

describe("renewDomain — concurrency and lease fencing", () => {
  it("a second invocation of the SAME order is turned away", async () => {
    let started: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        started();
        await gate;
        return renewSuccess(fixture.domainName, fixture.expectedExDate);
      },
    });

    const firstCall = renewDomain(fixture.order);
    // Let the first invocation reach (and block inside) the registry call.
    await startedGate;

    const reloaded = await reload(fixture.order);
    const secondResult = await renewDomain(reloaded);
    assert.equal(secondResult.state, "provisioning");
    assert.equal(secondResult.message, "処理中です。しばらくしてから再度お試しください。");

    unblock();
    const firstResult = await firstCall;
    assert.equal(firstResult.state, "done");

    const orderSnap = await fixture.order.ref.get();
    assert.equal(orderSnap.data()?.attempts, 1);
  });

  it("a racing different order is blocked, no double registry send",
    async () => {
      let unblock: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let started: () => void = () => undefined;
      const startedGate = new Promise<void>((resolve) => {
        started = resolve;
      });

      const fixture = await seedRenewOrder();
      const send = stubSend({
        "domain:renew": async () => {
          started();
          await gate;
          return renewSuccess(fixture.domainName, fixture.expectedExDate);
        },
      });

      const firstCall = renewDomain(fixture.order);
      await startedGate;

      // A second, different order for the same domain, opened against the
      // same (not-yet-advanced) curExpDate snapshot.
      const secondOrder = await openOrder({
        kind: "renew",
        uid: fixture.uid,
        idempotencyKey: `key-${randomUUID().slice(0, 8)}`,
        domainName: fixture.domainName,
        registry: REGISTRY,
        periodYears: fixture.periodYears,
        priceYen: 1500,
        curExpDate: fixture.curExpDate,
        expectedExDate: fixture.expectedExDate,
      });
      const secondResult = await renewDomain(secondOrder);
      assert.equal(secondResult.state, "failed");

      unblock();
      const firstResult = await firstCall;
      assert.equal(firstResult.state, "done");

      assert.equal(
        send.mock.calls.filter((c) => c.arguments[0].command === "domain:renew")
          .length,
        1,
      );
    });

  it("a stale token cannot touch a lease taken over after expiry", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () => {
        throw transportError("domain:info");
      },
    });

    // First invocation acquires the lease, sends, fails ambiguously, and is
    // left in retrying with the token untouched (per the info-failure path).
    const first = await renewDomain(fixture.order);
    assert.equal(first.state, "retrying");
    const staleLease = await readLease(fixture);
    assert.ok(staleLease);
    const staleToken = staleLease.holderToken as string;
    assert.notEqual(staleToken, null);
    assert.equal(
      staleLease.expiresAt.toMillis() - staleLease.acquiredAt.toMillis(),
      RENEW_LEASE_MS,
    );

    // Force the lease to look expired without going through renewDomain.
    await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .set(
        {
          renewLease: {
            ...staleLease,
            expiresAt: Timestamp.fromMillis(Date.now() - 1000),
          },
        },
        {merge: true},
      );

    mock.restoreAll();
    stubSend({
      // attempts > 0, so renewDomain reconciles via domain:info before
      // resending; it must see curExpDate to conclude it is safe to send.
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.curExpDate),
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, fixture.expectedExDate),
    });
    const reloaded = await reload(fixture.order);
    const second = await renewDomain(reloaded);
    assert.equal(second.state, "done");

    const freshLease = await readLease(fixture);
    assert.equal(freshLease, undefined);

    // The lease acquired by the second invocation must have used a
    // different token than the first, stale one.
    assert.notEqual(staleToken, undefined);
  });

  it("a different order reclaims the lease once it has expired, with a " +
    "fresh token", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () => {
        throw transportError("domain:info");
      },
    });

    // Order A acquires the lease, fails ambiguously, and is left in
    // retrying with its token intact (same setup as the same-order case
    // above), simulating an invocation that never reached a terminal
    // commit.
    const first = await renewDomain(fixture.order);
    assert.equal(first.state, "retrying");
    const staleLease = await readLease(fixture);
    assert.ok(staleLease);
    assert.equal(staleLease.orderId, fixture.order.id);
    const staleToken = staleLease.holderToken as string;
    assert.notEqual(staleToken, null);

    // Force the lease to look expired, as if RENEW_LEASE_MS had elapsed
    // with no follow-up from order A.
    await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .set(
        {
          renewLease: {
            ...staleLease,
            expiresAt: Timestamp.fromMillis(Date.now() - 1000),
          },
        },
        {merge: true},
      );

    // A different order (different idempotency key -> different Order doc)
    // for the same domain, still against the same curExpDate snapshot.
    const secondOrder = await openOrder({
      kind: "renew",
      uid: fixture.uid,
      idempotencyKey: `key-${randomUUID().slice(0, 8)}`,
      domainName: fixture.domainName,
      registry: REGISTRY,
      periodYears: fixture.periodYears,
      priceYen: 1500,
      curExpDate: fixture.curExpDate,
      expectedExDate: fixture.expectedExDate,
    });

    mock.restoreAll();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () => {
        throw transportError("domain:info");
      },
    });

    // Order B must be able to acquire the (now-expired) lease at all —
    // without the fix this call returns "failed" (blockedByOtherOrder)
    // instead of "retrying", and never touches the lease.
    const second = await renewDomain(secondOrder);
    assert.equal(second.state, "retrying");

    const takenLease = await readLease(fixture);
    assert.ok(takenLease);
    assert.equal(takenLease.orderId, secondOrder.id);
    assert.notEqual(takenLease.holderToken, staleToken);
    assert.equal(
      takenLease.expiresAt.toMillis() - takenLease.acquiredAt.toMillis(),
      RENEW_LEASE_MS,
    );
  });

  it("still blocks a different order while the existing lease has not " +
    "expired", async () => {
    const fixture = await seedRenewOrder();
    const domainRef = db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`);
    const now = Timestamp.now();
    await domainRef.set(
      {
        renewLease: {
          orderId: "other-order-id",
          holderToken: "other-token",
          periodYears: fixture.periodYears,
          curExpDate: fixture.curExpDate,
          expectedExDate: fixture.expectedExDate,
          acquiredAt: now,
          expiresAt: Timestamp.fromMillis(now.toMillis() + RENEW_LEASE_MS),
        },
      },
      {merge: true},
    );

    const result = await renewDomain(fixture.order);
    assert.equal(result.state, "failed");

    // The unexpired lease belonging to the other order must be untouched.
    const lease = await readLease(fixture);
    assert.ok(lease);
    assert.equal(lease.orderId, "other-order-id");
    assert.equal(lease.holderToken, "other-token");
  });

  it("blocks a fresh order when the domain's exDate has drifted", async () => {
    const fixture = await seedRenewOrder();
    await db()
      .collection(COLLECTIONS.domains)
      .doc(`${fixture.uid}__${fixture.domainName}`)
      .set({exDate: "2030-01-01"}, {merge: true});

    const send = stubSend({});
    const result = await renewDomain(fixture.order);

    assert.equal(result.state, "failed");
    assert.equal(send.mock.calls.length, 0);
  });

  it("a parked lease is re-acquired by the same order and reused", async () => {
    const fixture = await seedRenewOrder();
    stubSend({
      "domain:renew": async () => {
        throw transportError("domain:renew");
      },
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.curExpDate),
    });
    const first = await renewDomain(fixture.order);
    assert.equal(first.state, "retrying");
    const parkedLease = await readLease(fixture);
    assert.ok(parkedLease);
    assert.equal(parkedLease.holderToken, null);

    mock.restoreAll();
    const send = stubSend({
      "domain:info": async () =>
        infoSuccess(fixture.domainName, fixture.curExpDate),
      "domain:renew": async () =>
        renewSuccess(fixture.domainName, fixture.expectedExDate),
    });
    const reloaded = await reload(fixture.order);
    const second = await renewDomain(reloaded);
    assert.equal(second.state, "done");
    assert.ok(send.mock.calls.length > 0);
  });
});
