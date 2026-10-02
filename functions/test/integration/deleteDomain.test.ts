/**
 * `deleteDomain` — the "今すぐ削除" branch of FIG.4.
 *
 * Deleting is the most destructive thing this service does, so the ownership
 * check gets as much attention here as the happy path. The other theme is
 * that the life cycle written to Firestore always comes from `domain:info`
 * rather than from an assumption about what delete did.
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
import {deleteDomain} from "../../src/api/deleteDomain";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Shape the life-cycle Callables answer with. */
interface LifecycleResponse {
  domainName: string;
  registry: string;
  lifecycle: "active" | "pendingDelete" | "gone";
  status: string[];
  rgpStatus: string[];
  alreadyInState: boolean;
  restoreFeeYen?: number;
  message: string;
}

describe("deleteDomain", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
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

  /**
   * Registers a domain through the real order flow, so the Firestore record
   * and the registry agree before the test starts.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain to register.
   * @return {Promise<void>} Resolves once registered.
   */
  async function registerDomain(uid: string, name: string): Promise<void> {
    await callAs(createOrder, {
      domainName: name,
      idempotencyKey: testIdempotencyKey(),
    }, uid);
  }

  describe("access control (spec 7.3)", () => {
    it("rejects an anonymous caller", async () => {
      const code = await expectHttpsError(
        callAs(deleteDomain, {domainName: "anon.com"}),
      );
      assert.equal(code, "unauthenticated");
    });

    it("rejects a signed-in caller with no user document", async () => {
      // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
      // ID token alone must not be enough to reach this Callable.
      const code = await expectHttpsError(
        callAs(deleteDomain, {domainName: "no-user-doc.com"}, testUid()),
      );
      assert.equal(code, "permission-denied");
    });

    it("refuses a domain the caller never registered", async () => {
      const code = await expectHttpsError(
        callAs(deleteDomain, {domainName: "never-mine.com"}, await freshUid()),
      );
      assert.equal(code, "not-found");
    });

    it("refuses another member's domain, and leaves it alone", async () => {
      const owner = await freshUid();
      const intruder = await freshUid();
      await registerDomain(owner, "someone-elses.com");

      const code = await expectHttpsError(
        callAs(deleteDomain, {domainName: "someone-elses.com"}, intruder),
      );
      assert.equal(code, "not-found");
      assert.ok(
        !sign.getDomain("someone-elses.com")?.status.includes("pendingDelete"),
        "他人の削除要求で状態が変わらないこと",
      );
      assert.equal(sign.countCalls("DELETE", "/domains/someone-elses.com"), 0);
    });

    it("does not reveal that the domain exists", async () => {
      const owner = await freshUid();
      const intruder = await freshUid();
      await registerDomain(owner, "hidden.com");

      const missing = await expectHttpsError(
        callAs(deleteDomain, {domainName: "not-registered.com"}, intruder),
      );
      const foreign = await expectHttpsError(
        callAs(deleteDomain, {domainName: "hidden.com"}, intruder),
      );
      assert.equal(missing, foreign,
        "存在するかどうかで応答を変えないこと");
    });

    it("rejects a malformed name before looking anything up", async () => {
      const code = await expectHttpsError(
        callAs(deleteDomain, {domainName: "-bad-.com"}, await freshUid()),
      );
      assert.equal(code, "invalid-argument");
    });
  });

  describe("happy path", () => {
    it("moves the domain to pendingDelete", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "bye.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "bye.com"}, uid);

      assert.equal(result.lifecycle, "pendingDelete");
      assert.ok(result.status.includes("pendingDelete"));
      assert.equal(result.alreadyInState, false);
      assert.deepEqual(sign.getDomain("bye.com")?.status, ["pendingDelete"]);
      // The delete opens the RGP redemption window; that — not pendingDelete
      // on its own — is what makes the domain restorable.
      assert.deepEqual(result.rgpStatus, ["redemptionPeriod"]);
    });

    it("keeps the restore deadline the registry reported", async () => {
      // 「redemptionPeriod 期限の目安は extension.pendingDeleteUntil」: the
      // registry's own number, not our deletedAt + 45 arithmetic.
      const uid = await freshUid();
      await registerDomain(uid, "deadline-reported.com");
      sign.pendingDeleteUntil = "2026-11-01T00:00:00Z";

      await callAs(deleteDomain, {domainName: "deadline-reported.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__deadline-reported.com`).get();
      assert.equal(doc.data()?.restorableUntil, "2026-11-01T00:00:00Z");
    });

    it("copes with a registry that reports no deadline at all", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "no-deadline.com");
      sign.pendingDeleteUntil = null;

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "no-deadline.com"}, uid);

      assert.equal(result.lifecycle, "pendingDelete");
      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__no-deadline.com`).get();
      assert.equal(doc.data()?.restorableUntil, null,
        "期限が無いときは deletedAt + 猶予日数へ委ねること");
    });

    it("reports the registry's status rather than assuming one", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "rgp.com");
      await callAs(deleteDomain, {domainName: "rgp.com"}, uid);

      assert.equal(sign.countCalls("GET", "/domains/rgp.com"), 1,
        "delete のあとに domain:info で実際の状態を読むこと");
    });

    it("quotes what getting it back would cost", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "priced-restore.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "priced-restore.com"}, uid);

      // pricing.ts: .com の restoreYen。
      assert.equal(result.restoreFeeYen, 3300);
    });

    it("records the life cycle for the list screen", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "listed.com");
      await callAs(deleteDomain, {domainName: "listed.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__listed.com`).get();
      assert.equal(doc.data()?.lifecycle, "pendingDelete");
      assert.ok(doc.data()?.deletedAt);
      assert.equal(doc.data()?.autoRenew, false,
        "解約済みのドメインを自動更新の対象に残さないこと");
    });

    it("remembers the auto-renew setting the delete overwrote", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "remembered.com");

      await callAs(deleteDomain, {domainName: "remembered.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__remembered.com`).get();
      assert.equal(doc.data()?.autoRenewBeforeDelete, true,
        "復旧したときに元の設定へ戻せるようにすること");
    });

    it("remembers an auto-renew setting that was already off", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "already-off.com");
      await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__already-off.com`).update({autoRenew: false});

      await callAs(deleteDomain, {domainName: "already-off.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__already-off.com`).get();
      assert.equal(doc.data()?.autoRenewBeforeDelete, false);
      assert.equal(doc.data()?.autoRenew, false);
    });

    it("uses a clTRID that names the domain and the command", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "traced.com");
      await callAs(deleteDomain, {domainName: "traced.com"}, uid);

      const call = sign.calls.find((entry) =>
        entry.method === "DELETE" && entry.path === "/domains/traced.com");
      assert.match(call?.clTRID ?? "", /^DOM-DELETE-TRACED-COM-/);
    });

    it("normalises the name before acting on it", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "mixedcase.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "  MixedCase.COM "}, uid);

      assert.equal(result.domainName, "mixedcase.com");
      assert.equal(result.lifecycle, "pendingDelete");
    });
  });

  describe("repeating the command", () => {
    it("does not delete an already-deleted domain twice", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "twice.com");
      await callAs(deleteDomain, {domainName: "twice.com"}, uid);
      const before = sign.countCalls("DELETE", "/domains/twice.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "twice.com"}, uid);

      assert.equal(result.alreadyInState, true);
      assert.equal(result.lifecycle, "pendingDelete");
      assert.equal(sign.countCalls("DELETE", "/domains/twice.com"), before);
    });

    it("reports a domain the grace period already claimed", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "expired.com");
      await callAs(deleteDomain, {domainName: "expired.com"}, uid);
      sign.expireGracePeriod("expired.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "expired.com"}, uid);

      assert.equal(result.lifecycle, "gone");
      assert.equal(result.alreadyInState, true);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__expired.com`).get();
      assert.equal(doc.data()?.lifecycle, "gone");
    });

    it("never deletes a name that was re-registered by someone else",
      async () => {
        // Regression: member A's domain expires; member B re-registers the
        // same name through this service. The registry sees a legitimate
        // sponsor either way, so only the registrant comparison protects B.
        const memberA = await freshUid();
        await registerDomain(memberA, "recycled.com");
        await callAs(deleteDomain, {domainName: "recycled.com"}, memberA);
        sign.expireGracePeriod("recycled.com");

        const memberB = await freshUid();
        await registerDomain(memberB, "recycled.com");
        const deletesBefore = sign.countCalls("DELETE",
          "/domains/recycled.com");

        const result = await callAs<LifecycleResponse>(
          deleteDomain, {domainName: "recycled.com"}, memberA);

        assert.equal(result.lifecycle, "gone",
          "A には「もう自分のものではない」と伝わること");
        assert.equal(sign.countCalls("DELETE", "/domains/recycled.com"),
          deletesBefore, "B のドメインへ delete を発行しないこと");
        assert.ok(
          !sign.getDomain("recycled.com")?.status.includes("pendingDelete"),
          "B のドメインが生きたままであること");

        const aRecord = await db().collection(COLLECTIONS.domains)
          .doc(`${memberA}__recycled.com`).get();
        assert.equal(aRecord.data()?.lifecycle, "gone");
        const bRegistrant = sign.getDomain("recycled.com")?.registrant;
        assert.notEqual(aRecord.data()?.registrant, bRegistrant,
          "B の registrant を A のレコードへ書き込まないこと");
      });

    it("treats a 404 from delete as the outcome we wanted", async () => {
      const uid = await freshUid();
      await registerDomain(uid, "vanished.com");
      // Our record still says active, but the registry no longer has it.
      sign.expireGracePeriod("vanished.com");

      const result = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "vanished.com"}, uid);

      assert.equal(result.lifecycle, "gone");
      assert.equal(result.alreadyInState, true);
    });
  });

  describe("registry failure", () => {
    it("surfaces a transport failure without changing our record",
      async () => {
        const uid = await freshUid();
        await registerDomain(uid, "flaky-delete.com");
        sign.helloFails = false;
        sign.delayMs = 0;
        // Make the DELETE itself fail at the transport level.
        process.env.REGISTRY_TIMEOUT_MS = "80";
        sign.delayMs = 400;
        try {
          const code = await expectHttpsError(
            callAs(deleteDomain, {domainName: "flaky-delete.com"}, uid),
          );
          assert.equal(code, "unavailable");
        } finally {
          delete process.env.REGISTRY_TIMEOUT_MS;
          sign.delayMs = 0;
        }

        const doc = await db().collection(COLLECTIONS.domains)
          .doc(`${uid}__flaky-delete.com`).get();
        assert.equal(doc.data()?.lifecycle, "active",
          "失敗した削除で状態を進めないこと");
      });
  });
});
