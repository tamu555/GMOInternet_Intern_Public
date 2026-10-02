/**
 * The `createOrder` Callable — the API layer's half of FIG.1.
 *
 * Two things matter here beyond "it registers a domain": a resubmitted form
 * must not charge twice, and every constraint that would earn an HTTP 400
 * from the registry has to be caught before the request leaves us.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  activeMemberUid,
  callAs,
  expectHttpsError,
  requireEmulator,
  testIdempotencyKey,
  testUid,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {createOrder} from "../../src/api/createOrder";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Shape `createOrder` answers with. */
interface CreateOrderResult {
  orderId: string;
  orderSeq: number;
  priceYen: number;
  state: string;
  domainName: string;
  registry: string;
  exDate?: string;
  nameservers: string[];
  recovered: boolean;
  message: string;
}

describe("createOrder", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;
  const uids: string[] = [];

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
  });

  after(async () => {
    await cleanupTestData(uids, counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(() => {
    sign.reset();
    nic.reset();
    resetTldCache();
  });

  /**
   * Allocates an active-member uid that will be cleaned up afterwards.
   *
   * @return {Promise<string>} Test uid backed by an active user document.
   */
  async function freshUid(): Promise<string> {
    const uid = await activeMemberUid();
    uids.push(uid);
    return uid;
  }

  describe("authentication", () => {
    it("rejects an anonymous caller", async () => {
      const code = await expectHttpsError(callAs(createOrder, {
        domainName: "anon.com",
        idempotencyKey: testIdempotencyKey(),
      }));
      assert.equal(code, "unauthenticated");
    });

    it("never reaches the registry when unauthenticated", async () => {
      await expectHttpsError(callAs(createOrder, {
        domainName: "anon.com",
        idempotencyKey: testIdempotencyKey(),
      }));
      assert.equal(sign.calls.length, 0);
    });

    it("rejects a signed-in caller with no user document", async () => {
      // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
      // ID token alone — mintable straight against Identity Toolkit's public
      // accounts:signUp — must not be enough to reach this Callable.
      const code = await expectHttpsError(callAs(createOrder, {
        domainName: "no-user-doc.com",
        idempotencyKey: testIdempotencyKey(),
      }, testUid()));
      assert.equal(code, "permission-denied");
    });
  });

  describe("input validation (spec 3.4)", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing domain", {}],
      ["malformed domain", {domainName: "-bad-.com"}],
      ["no TLD", {domainName: "localhost"}],
      ["period above ten years", {domainName: "ok.com", periodYears: 11}],
      ["period below one year", {domainName: "ok.com", periodYears: 0}],
      ["nameserver that is not a hostname",
        {domainName: "ok.com", nameservers: ["not a host"]}],
      ["contact name outside the allow-list",
        {domainName: "ok.com", contact: {name: "田村 太郎"}}],
      ["over-long authInfo",
        {domainName: "ok.com", authInfo: "x".repeat(65)}],
    ];

    for (const [label, payload] of cases) {
      it(`rejects: ${label}`, async () => {
        const code = await expectHttpsError(callAs(createOrder, {
          idempotencyKey: testIdempotencyKey(),
          ...payload,
        }, await freshUid()));
        assert.equal(code, "invalid-argument");
      });
    }

    it("rejects an idempotency key that is too short to be unique",
      async () => {
        const code = await expectHttpsError(callAs(createOrder, {
          domainName: "ok.com",
          idempotencyKey: "x",
        }, await freshUid()));
        assert.equal(code, "invalid-argument");
      });

    it("rejects a TLD neither registry serves", async () => {
      const code = await expectHttpsError(callAs(createOrder, {
        domainName: "nope.zzz",
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid()));
      assert.equal(code, "invalid-argument");
    });

    it("validates before spending a registry call", async () => {
      await expectHttpsError(callAs(createOrder, {
        domainName: "-bad-.com",
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid()));
      assert.equal(sign.countCalls("POST", "/domains"), 0);
    });
  });

  describe("happy path", () => {
    it("registers the domain and answers with the order", async () => {
      const result = await callAs<CreateOrderResult>(createOrder, {
        domainName: "Callable-Happy.COM",
        periodYears: 2,
        nameservers: ["ns1.example.com", "ns2.example.com"],
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid());

      assert.equal(result.state, "done");
      assert.equal(result.domainName, "callable-happy.com",
        "正規化された名前で返ること");
      assert.equal(result.registry, "kitaqsign");
      assert.equal(result.recovered, false);
      assert.equal(result.nameservers.length, 2);
      assert.ok(result.exDate);
      assert.ok(result.message.length > 0);
    });

    it("prices the order on the server, ignoring the client", async () => {
      const result = await callAs<CreateOrderResult>(createOrder, {
        domainName: "priced.com",
        periodYears: 2,
        priceYen: 1,
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid());

      // pricing.ts: .com は初年度 1480 + 更新 1980 × (2 - 1)。
      assert.equal(result.priceYen, 3460);
    });

    it("routes by TLD without the client saying which registry", async () => {
      const result = await callAs<CreateOrderResult>(createOrder, {
        domainName: "routed.shop",
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid());

      assert.equal(result.registry, "kitaqnic");
      assert.ok(nic.getDomain("routed.shop"));
      assert.equal(sign.countCalls("POST", "/domains"), 0);
    });
  });

  describe("double submit (二重課金防止)", () => {
    it("returns the same order for a replayed key", async () => {
      const uid = await freshUid();
      const key = testIdempotencyKey();
      const payload = {domainName: "replay.com", idempotencyKey: key};

      const first = await callAs<CreateOrderResult>(createOrder, payload, uid);
      const second = await callAs<CreateOrderResult>(createOrder, payload,
        uid);

      assert.equal(second.orderId, first.orderId);
      assert.equal(second.orderSeq, first.orderSeq);
      assert.equal(second.state, "done");
    });

    it("opens exactly one order document", async () => {
      const uid = await freshUid();
      const key = testIdempotencyKey();
      const payload = {domainName: "single.com", idempotencyKey: key};

      await callAs(createOrder, payload, uid);
      await callAs(createOrder, payload, uid);

      const orders = await db().collection(COLLECTIONS.orders)
        .where("uid", "==", uid).get();
      assert.equal(orders.size, 1);
    });

    it("issues only one domain:create for the replayed key", async () => {
      const uid = await freshUid();
      const payload = {
        domainName: "onlyonce.com",
        idempotencyKey: testIdempotencyKey(),
      };
      await callAs(createOrder, payload, uid);
      await callAs(createOrder, payload, uid);

      assert.equal(sign.countCalls("POST", "/domains"), 1);
    });

    it("survives two submits racing each other", async () => {
      const uid = await freshUid();
      const payload = {
        domainName: "raced.com",
        idempotencyKey: testIdempotencyKey(),
      };

      const [a, b] = await Promise.all([
        callAs<CreateOrderResult>(createOrder, payload, uid),
        callAs<CreateOrderResult>(createOrder, payload, uid),
      ]);

      assert.equal(a.orderId, b.orderId);
      const orders = await db().collection(COLLECTIONS.orders)
        .where("uid", "==", uid).get();
      assert.equal(orders.size, 1);
    });

    it("refuses to reuse one key for a different domain", async () => {
      const uid = await freshUid();
      const key = testIdempotencyKey();
      await callAs(createOrder, {domainName: "first.com",
        idempotencyKey: key}, uid);

      const code = await expectHttpsError(callAs(createOrder,
        {domainName: "second.com", idempotencyKey: key}, uid));
      assert.equal(code, "invalid-argument");
    });

    it("keeps one order per member, not per service", async () => {
      const key = testIdempotencyKey();
      const a = await callAs<CreateOrderResult>(createOrder,
        {domainName: "shared-a.com", idempotencyKey: key}, await freshUid());
      const b = await callAs<CreateOrderResult>(createOrder,
        {domainName: "shared-b.com", idempotencyKey: key}, await freshUid());

      assert.notEqual(a.orderId, b.orderId,
        "別の会員が同じキーを使っても衝突しないこと");
    });
  });

  describe("failure paths reach the client as order state", () => {
    it("reports retrying instead of throwing", async () => {
      sign.failNextCreates(1);
      const result = await callAs<CreateOrderResult>(createOrder, {
        domainName: "wobbly.com",
        idempotencyKey: testIdempotencyKey(),
      }, await freshUid());

      assert.equal(result.state, "retrying");
      assert.ok(result.message.includes("再試行"));
    });

    it("reports a taken domain without claiming it", async () => {
      sign.seedDomain("owned.com", "OTHER001");
      const uid = await freshUid();
      const result = await callAs<CreateOrderResult>(createOrder, {
        domainName: "owned.com",
        idempotencyKey: testIdempotencyKey(),
      }, uid);

      assert.equal(result.state, "failed");
      const domains = await db().collection(COLLECTIONS.domains)
        .where("uid", "==", uid).get();
      assert.equal(domains.size, 0);
    });

    it("does not leak clTRIDs or registry internals to the client",
      async () => {
        sign.failNextCreates(1);
        const result = await callAs<CreateOrderResult>(createOrder, {
          domainName: "opaque.com",
          idempotencyKey: testIdempotencyKey(),
        }, await freshUid());

        assert.doesNotMatch(result.message, /ORD-|SV-|http/i);
      });
  });
});
