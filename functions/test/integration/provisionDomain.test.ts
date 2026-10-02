/**
 * The registration use case — FIG.1's "PROV" box and all of FIG.2.
 *
 * The happy path is the least interesting thing here. What these tests are
 * really for is the three exits: plain success, "2302 but `domain:info` says
 * an earlier attempt of ours already worked" (spec 6.7), and a transport
 * failure that must never turn into a second charge.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
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
import {openOrder, type OrderHandle} from "../../src/domain/orders";
import {ensureUserContactProfile} from "../../src/domain/contacts";
import {
  ORDER_MAX_ATTEMPTS,
  provisionDomain,
} from "../../src/domain/provisionDomain";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

describe("provisionDomain", {skip: HAS_EMULATOR ? false : SKIP_REASON},
  () => {
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
     * Opens a paid order ready to be provisioned.
     *
     * @param {string} domainName Domain to register.
     * @param {string[]} nameservers Nameservers requested on the form.
     * @return {Promise<OrderHandle>} Order handle plus its uid.
     */
    async function makeOrder(
      domainName: string,
      nameservers: string[] = [],
    ): Promise<OrderHandle> {
      const uid = testUid();
      uids.push(uid);
      return openOrder({
        kind: "create",
        uid,
        idempotencyKey: testIdempotencyKey(),
        domainName,
        registry: "kitaqsign",
        periodYears: 1,
        nameservers,
        priceYen: 1500,
        authInfo: "test-auth-info",
      });
    }

    it("registers the domain and reports done", async () => {
      const order = await makeOrder("happy.com");
      const result = await provisionDomain(order, {});

      assert.equal(result.state, "done");
      assert.equal(result.recovered, false);
      assert.equal(result.domainName, "happy.com");
      assert.equal(result.exDate, "2027-08-25T10:00:00Z");
      assert.ok(sign.getDomain("happy.com"));
    });

    it("creates the contact before the domain", async () => {
      const order = await makeOrder("ordering.com");
      await provisionDomain(order, {});

      const paths = sign.calls.map((call) => call.path);
      assert.ok(paths.indexOf("/contacts") < paths.indexOf("/domains"),
        "contact:create が domain:create より先であること");
    });

    it("registers the domain against our own contact", async () => {
      const order = await makeOrder("registrant.com");
      await provisionDomain(order, {});

      const contactId = sign.getDomain("registrant.com")?.registrant;
      assert.match(contactId ?? "", /^U\d{6}$/);
      assert.ok((contactId ?? "").length <= 16,
        "コンタクトIDは16文字以内であること");
    });

    describe("nameservers are attached after the create, never during it",
      () => {
        it("registers without nameservers when the order has none",
          async () => {
            const order = await makeOrder("nons.com");
            const result = await provisionDomain(order, {});

            assert.equal(result.state, "done");
            assert.deepEqual(result.nameservers, []);
            assert.deepEqual(sign.getDomain("nons.com")?.status, ["inactive"],
              "NS未設定のドメインは inactive で着地すること");
            assert.equal(sign.countCalls("PUT", "/domains/nons.com"), 0,
              "設定する NS がなければ domain:update は発行しないこと");
          });

        it("keeps the nameservers out of the create request", async () => {
          const order = await makeOrder("withns.com",
            ["ns1.example.com", "ns2.example.com"]);
          await provisionDomain(order, {});

          const create = sign.calls.find((call) =>
            call.method === "POST" && call.path === "/domains");
          assert.ok(create, "domain:create が発行されていること");
          assert.equal(create.body?.nameservers, undefined,
            "支払い済みの注文を DNS の都合で失敗させないこと");
        });

        it("attaches them with domain:update once the domain exists",
          async () => {
            const order = await makeOrder("withns.com",
              ["ns1.example.com", "ns2.example.com"]);
            const result = await provisionDomain(order, {});

            assert.deepEqual(sign.getDomain("withns.com")?.nameservers,
              ["ns1.example.com", "ns2.example.com"]);
            assert.deepEqual(result.nameservers,
              ["ns1.example.com", "ns2.example.com"]);
            assert.equal(result.nameserverUpdateFailed, undefined);

            const paths = sign.calls.map((call) => call.path);
            assert.ok(
              paths.indexOf("/domains") <
                paths.indexOf("/domains/withns.com"),
              "domain:update は domain:create のあとであること");
          });

        it("still completes the order when the update is refused",
          async () => {
            sign.failNextUpdates(1);
            const order = await makeOrder("nsrefused.com",
              ["ns1.example.com"]);
            const result = await provisionDomain(order, {});

            assert.equal(result.state, "done",
              "NS が付かなくてもドメインは登録済み・注文は成功");
            assert.equal(result.nameserverUpdateFailed, true);
            assert.deepEqual(result.nameservers, [],
              "レジストリが持っていない NS を返さないこと");
            assert.ok(sign.getDomain("nsrefused.com"));
          });

        it("records why the nameservers are missing", async () => {
          sign.failNextUpdates(1);
          const order = await makeOrder("nsrecorded.com",
            ["ns1.example.com"]);
          await provisionDomain(order, {});

          const doc = await order.ref.get();
          assert.equal(doc.data()?.state, "done");
          assert.deepEqual(doc.data()?.result?.nameservers, []);
          assert.equal(doc.data()?.result?.nameserverError?.kind,
            "objectNotFound");
          assert.deepEqual(doc.data()?.nameservers, ["ns1.example.com"],
            "希望した NS は注文に残ること");
        });

        it("does not mirror nameservers the registry never accepted",
          async () => {
            sign.failNextUpdates(1);
            const order = await makeOrder("nsmirror.com",
              ["ns1.example.com"]);
            await provisionDomain(order, {});

            const doc = await db().collection(COLLECTIONS.domains)
              .doc(`${order.data.uid}__nsmirror.com`).get();
            assert.deepEqual(doc.data()?.nameservers, []);
            assert.deepEqual(doc.data()?.status, ["inactive"]);
          });

        it("never issues host:create for the order's nameservers",
          async () => {
            const order = await makeOrder("nohosts.com",
              ["ns1.example.com", "ns2.example.com"]);
            await provisionDomain(order, {});

            assert.equal(sign.countCalls("POST", "/hosts"), 0,
              "他人と共有するホストオブジェクトを購入時に作らないこと");
          });
      });

    it("persists the domain so the list screen has data", async () => {
      const order = await makeOrder("persisted.com");
      await provisionDomain(order, {});

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${order.data.uid}__persisted.com`).get();
      assert.ok(doc.exists);
      assert.equal(doc.data()?.exDate, "2027-08-25T10:00:00Z");
      assert.equal(doc.data()?.tld, "com");
    });

    it("uses a deterministic clTRID for the create", async () => {
      const order = await makeOrder("cltrid.com");
      await provisionDomain(order, {});

      const create = sign.calls.find((call) =>
        call.method === "POST" && call.path === "/domains");
      assert.match(create?.clTRID ?? "", /^ORD-\d{6}-CREATE-01$/);
    });

    describe("2302 recovery (spec 6.7)", () => {
      it("treats our own existing domain as a success", async () => {
        // Register once, then order the same name again as if the first
        // attempt had died before its answer reached us.
        const first = await makeOrder("recover.com");
        await provisionDomain(first, {});
        sign.calls.length = 0;

        const second = await openOrder({
          kind: "create",
          uid: first.data.uid,
          idempotencyKey: testIdempotencyKey(),
          domainName: "recover.com",
          registry: "kitaqsign",
          periodYears: 1,
          nameservers: [],
          priceYen: 1500,
          authInfo: "test-auth-info",
        });
        const result = await provisionDomain(second, {});

        assert.equal(result.state, "done");
        assert.equal(result.recovered, true);
        assert.equal(sign.countCalls("GET", "/domains/recover.com"), 1,
          "2302 のあとに domain:info で確認すること");
      });

      it("finishes the nameservers the dead attempt never set", async () => {
        const first = await makeOrder("halfdone.com");
        await provisionDomain(first, {});

        const second = await openOrder({
          kind: "create",
          uid: first.data.uid,
          idempotencyKey: testIdempotencyKey(),
          domainName: "halfdone.com",
          registry: "kitaqsign",
          periodYears: 1,
          nameservers: ["ns1.example.com"],
          priceYen: 1500,
          authInfo: "test-auth-info",
        });
        const result = await provisionDomain(second, {});

        assert.equal(result.state, "done");
        assert.deepEqual(result.nameservers, ["ns1.example.com"]);
        assert.equal(sign.countCalls("PUT", "/domains/halfdone.com"), 1);
      });

      it("refuses to claim a domain registered to someone else", async () => {
        sign.seedDomain("foreign.com", "OTHER001");
        const order = await makeOrder("foreign.com");
        const result = await provisionDomain(order, {});

        assert.equal(result.state, "failed");
        assert.equal(result.recovered, false);

        const doc = await db().collection(COLLECTIONS.domains)
          .doc(`${order.data.uid}__foreign.com`).get();
        assert.equal(doc.exists, false,
          "他人のドメインを自分のものとして保存しないこと");
      });
    });

    describe("transport failure", () => {
      it("turns a contact-stage failure into retrying, not an exception",
        async () => {
          // Regression: ensureRegistryContact used to sit outside the try,
          // so a registry timeout during contact:create escaped as an
          // exception and stranded the order in `provisioning` — a state
          // nothing picks back up.
          sign.failNextContacts(1);
          const order = await makeOrder("contact-flaky.com");

          const result = await provisionDomain(order, {});

          assert.equal(result.state, "retrying",
            "contact 失敗も domain:create 失敗と同じく state で返すこと");
          const doc = await order.ref.get();
          assert.equal(doc.data()?.state, "retrying",
            "注文を provisioning のまま置き去りにしないこと");
        });

      it("recovers a contact-stage failure on the next attempt", async () => {
        sign.failNextContacts(1);
        const order = await makeOrder("contact-comeback.com");
        assert.equal((await provisionDomain(order, {})).state, "retrying");

        const result = await provisionDomain(order, {});

        assert.equal(result.state, "done");
        assert.ok(sign.getDomain("contact-comeback.com"));
      });

      it("reports retrying without charging again", async () => {
        sign.failNextCreates(1);
        const order = await makeOrder("flaky.com");
        const result = await provisionDomain(order, {});

        assert.equal(result.state, "retrying");
        const doc = await order.ref.get();
        assert.equal(doc.data()?.state, "retrying");
        assert.equal(doc.data()?.attempts, 1);
        assert.equal(doc.data()?.priceYen, 1500, "金額は変わらないこと");
      });

      it("recovers when the registry comes back", async () => {
        sign.failNextCreates(1);
        const order = await makeOrder("comesback.com");
        assert.equal((await provisionDomain(order, {})).state, "retrying");

        const result = await provisionDomain(order, {});
        assert.equal(result.state, "done");
        assert.equal(order.data.attempts, 2);
      });

      it("gives up after the attempt limit", async () => {
        sign.failNextCreates(ORDER_MAX_ATTEMPTS);
        const order = await makeOrder("neverworks.com");

        const states: string[] = [];
        for (let i = 0; i < ORDER_MAX_ATTEMPTS; i++) {
          states.push((await provisionDomain(order, {})).state);
        }

        assert.deepEqual(states.slice(0, -1),
          new Array(ORDER_MAX_ATTEMPTS - 1).fill("retrying"));
        assert.equal(states[states.length - 1], "failed");
      });

      it("issues exactly one create per attempt", async () => {
        sign.failNextCreates(1);
        const order = await makeOrder("onceperattempt.com");
        await provisionDomain(order, {});
        assert.equal(sign.countCalls("POST", "/domains"), 1,
          "create を自動再送すると二重登録の危険がある");
      });
    });

    describe("replaying a settled order", () => {
      it("returns done without touching the registry", async () => {
        const order = await makeOrder("settled.com");
        await provisionDomain(order, {});
        sign.calls.length = 0;

        const result = await provisionDomain(order, {});
        assert.equal(result.state, "done");
        assert.equal(sign.calls.length, 0);
      });

      it("keeps a written-off order written off", async () => {
        sign.failNextCreates(ORDER_MAX_ATTEMPTS);
        const order = await makeOrder("writtenoff.com");
        for (let i = 0; i < ORDER_MAX_ATTEMPTS; i++) {
          await provisionDomain(order, {});
        }
        sign.calls.length = 0;

        const result = await provisionDomain(order, {});
        assert.equal(result.state, "failed");
        assert.equal(sign.calls.length, 0,
          "返金済みの注文でレジストリを叩き直さないこと");
      });
    });

    describe("contact reuse (spec 5.1)", () => {
      it("creates the contact once and reuses it", async () => {
        const uid = testUid();
        uids.push(uid);
        for (const name of ["one.com", "two.com"]) {
          const order = await openOrder({
            kind: "create",
            uid,
            idempotencyKey: testIdempotencyKey(),
            domainName: name,
            registry: "kitaqsign",
            periodYears: 1,
            nameservers: [],
            priceYen: 1500,
            authInfo: "test-auth-info",
          });
          assert.equal((await provisionDomain(order, {})).state, "done");
        }
        assert.equal(sign.countCalls("POST", "/contacts"), 1,
          "2件目の注文でコンタクトを作り直さないこと");
      });

      it("accepts 2302 from contact:create as already ours", async () => {
        const order = await makeOrder("contactdup.com");
        // Allocate the member's contact id, then plant it on the registry so
        // contact:create answers 2302 — the shape of a previous attempt that
        // succeeded without us hearing about it.
        const profile = await ensureUserContactProfile(order.data.uid);
        sign.seedContact(profile.contactId);

        const result = await provisionDomain(order, {});
        assert.equal(result.state, "done");
        assert.equal(sign.getDomain("contactdup.com")?.registrant,
          profile.contactId);
      });
    });
  });
