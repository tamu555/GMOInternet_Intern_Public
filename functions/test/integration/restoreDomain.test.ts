/**
 * `restoreDomain` — the "復旧" arrow of FIG.4.
 *
 * Restore has three distinct ways to fail and the member needs to be able to
 * tell them apart: too late (the grace period ended), nothing to do (the
 * domain is live), and not ours (another registrar sponsors it). The registry
 * signals those as 404, 2304 and 403 respectively, and collapsing any two of
 * them into one message would leave the screen unable to say what happened.
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
import {restoreDomain} from "../../src/api/restoreDomain";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";
import {FieldValue} from "firebase-admin/firestore";

/** Shape the life-cycle Callables answer with. */
interface LifecycleResponse {
  domainName: string;
  registry: string;
  lifecycle: "active" | "pendingDelete" | "gone";
  status: string[];
  rgpStatus: string[];
  alreadyInState: boolean;
  message: string;
}

describe("restoreDomain", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
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
   * Registers a domain and then deletes it, leaving it restorable.
   *
   * @param {string} uid Owner.
   * @param {string} name Domain name.
   * @return {Promise<void>} Resolves once the domain is pendingDelete.
   */
  async function registerAndDelete(
    uid: string,
    name: string,
  ): Promise<void> {
    await callAs(createOrder, {
      domainName: name,
      idempotencyKey: testIdempotencyKey(),
    }, uid);
    await callAs(deleteDomain, {domainName: name}, uid);
  }

  describe("access control (spec 7.3)", () => {
    it("rejects an anonymous caller", async () => {
      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "anon.com"}),
      );
      assert.equal(code, "unauthenticated");
    });

    it("rejects a signed-in caller with no user document", async () => {
      // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
      // ID token alone must not be enough to reach this Callable.
      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "no-user-doc.com"}, testUid()),
      );
      assert.equal(code, "permission-denied");
    });

    it("refuses a domain the caller never registered", async () => {
      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "never-mine.com"}, await freshUid()),
      );
      assert.equal(code, "not-found");
    });

    it("refuses to restore another member's domain", async () => {
      const owner = await freshUid();
      const intruder = await freshUid();
      await registerAndDelete(owner, "not-yours.com");

      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "not-yours.com"}, intruder),
      );
      assert.equal(code, "not-found");
      assert.deepEqual(sign.getDomain("not-yours.com")?.status,
        ["pendingDelete"], "他人の復旧要求で状態が変わらないこと");
      assert.equal(sign.countCalls("POST", "/domains/not-yours.com/restore"),
        0, "所有権チェックがレジストリより手前で効くこと");
    });
  });

  describe("happy path", () => {
    it("brings a pendingDelete domain back", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "comeback.com");

      const result = await callAs<LifecycleResponse>(
        restoreDomain, {domainName: "comeback.com"}, uid);

      assert.equal(result.lifecycle, "active");
      assert.equal(result.alreadyInState, false);
      assert.ok(!result.status.includes("pendingDelete"));
      // No nameservers were set, so the registry puts it back as `inactive`
      // rather than `ok` (RFC 5731). Either way it is out of pendingDelete.
      assert.deepEqual(sign.getDomain("comeback.com")?.status, ["inactive"]);
    });

    it("clears the RGP status the delete had set", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "rgp-cleared.com");

      const result = await callAs<LifecycleResponse>(
        restoreDomain, {domainName: "rgp-cleared.com"}, uid);

      assert.deepEqual(result.rgpStatus, []);
    });

    it("records the restore for the list screen", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "recorded.com");
      await callAs(restoreDomain, {domainName: "recorded.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__recorded.com`).get();
      assert.equal(doc.data()?.lifecycle, "active");
      assert.ok(doc.data()?.restoredAt);
      assert.equal(doc.data()?.deletedAt, undefined,
        "生き返ったドメインに削除日時を残さないこと");
      assert.equal(doc.data()?.autoRenewBeforeDelete, undefined,
        "復旧のたびに使い切る目印を残さないこと");
    });

    it("says so, in the words the screen shows", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "worded.com");

      const result = await callAs<LifecycleResponse>(
        restoreDomain, {domainName: "worded.com"}, uid);

      assert.equal(result.message, "ドメインを復旧しました。");
    });

    it("puts auto-renew back on when it was on before the delete",
      async () => {
        // Without this the domain comes back with autoRenew=false — the value
        // the delete forced — and the app-side batch deletes it again at
        // exDate (spec 6.4), undoing the restore the member paid for.
        const uid = await freshUid();
        await registerAndDelete(uid, "renew-on.com");

        await callAs(restoreDomain, {domainName: "renew-on.com"}, uid);

        const doc = await db().collection(COLLECTIONS.domains)
          .doc(`${uid}__renew-on.com`).get();
        assert.equal(doc.data()?.autoRenew, true);
      });

    it("leaves auto-renew off when it was off before the delete", async () => {
      const uid = await freshUid();
      await callAs(createOrder, {
        domainName: "renew-off.com",
        idempotencyKey: testIdempotencyKey(),
      }, uid);
      await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__renew-off.com`).update({autoRenew: false});
      await callAs(deleteDomain, {domainName: "renew-off.com"}, uid);

      await callAs(restoreDomain, {domainName: "renew-off.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__renew-off.com`).get();
      assert.equal(doc.data()?.autoRenew, false,
        "会員が自分で切った設定を復旧が勝手に入れ直さないこと");
    });

    it("turns auto-renew back on for a domain deleted before the marker " +
      "existed", async () => {
      // Legacy records carry no autoRenewBeforeDelete. The stored `false` is
      // the delete's own doing, not a preference, so the restore assumes ON
      // rather than letting the batch delete the domain again.
      const uid = await freshUid();
      await registerAndDelete(uid, "legacy-marker.com");
      await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__legacy-marker.com`)
        .update({autoRenewBeforeDelete: FieldValue.delete()});

      await callAs(restoreDomain, {domainName: "legacy-marker.com"}, uid);

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__legacy-marker.com`).get();
      assert.equal(doc.data()?.autoRenew, true);
    });

    it("uses a clTRID that names the domain and the command", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "traced-restore.com");
      await callAs(restoreDomain, {domainName: "traced-restore.com"}, uid);

      const call = sign.calls.find((entry) =>
        entry.path === "/domains/traced-restore.com/restore");
      assert.match(call?.clTRID ?? "", /^DOM-RESTORE-TRACED-RESTORE-COM-/);
    });

    it("survives a delete and restore round trip", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "roundtrip.com");
      await callAs(restoreDomain, {domainName: "roundtrip.com"}, uid);

      const second = await callAs<LifecycleResponse>(
        deleteDomain, {domainName: "roundtrip.com"}, uid);
      assert.equal(second.lifecycle, "pendingDelete");

      const back = await callAs<LifecycleResponse>(
        restoreDomain, {domainName: "roundtrip.com"}, uid);
      assert.equal(back.lifecycle, "active");
    });
  });

  describe("the RGP state machine (redemptionPeriod → pendingDelete → 抹消)",
    () => {
      it("restores while the domain is in redemptionPeriod", async () => {
        const uid = await freshUid();
        await registerAndDelete(uid, "in-redemption.com");
        assert.ok(sign.getDomain("in-redemption.com")?.rgpStatus
          .includes("redemptionPeriod"), "前提: 復旧猶予期間にいること");

        const result = await callAs<LifecycleResponse>(
          restoreDomain, {domainName: "in-redemption.com"}, uid);

        assert.equal(result.lifecycle, "active");
      });

      it("restores just as well when redemptionPeriod rides in status",
        async () => {
          // The registries' prose lists redemptionPeriod among the `status`
          // values while the schema calls RGP a separate layer. Neither
          // reading may change what the member can do.
          const uid = await freshUid();
          await registerAndDelete(uid, "status-carried.com");
          const domain = sign.getDomain("status-carried.com");
          if (domain) {
            domain.status = ["pendingDelete", "redemptionPeriod"];
            domain.rgpStatus = [];
          }

          const result = await callAs<LifecycleResponse>(
            restoreDomain, {domainName: "status-carried.com"}, uid);

          assert.equal(result.lifecycle, "active");
        });

      it("refuses once redemptionPeriod has lapsed, without issuing the " +
        "command", async () => {
        // The 45 days are up: the registry has dropped redemptionPeriod and
        // left pendingDelete alone, where restore is documented to answer
        // 2304. Sending it anyway would be a round trip to a certain refusal.
        const uid = await freshUid();
        await registerAndDelete(uid, "too-late-tail.com");
        sign.endRedemptionPeriod("too-late-tail.com");

        const code = await expectHttpsError(
          callAs(restoreDomain, {domainName: "too-late-tail.com"}, uid),
        );

        assert.equal(code, "failed-precondition");
        assert.equal(
          sign.countCalls("POST", "/domains/too-late-tail.com/restore"), 0,
          "確実に失敗するコマンドをレジストリへ送らないこと");
      });

      it("records the lapsed window on the mirror, so the list stops " +
        "offering a restore", async () => {
        const uid = await freshUid();
        await registerAndDelete(uid, "tail-mirrored.com");
        sign.endRedemptionPeriod("tail-mirrored.com");

        await expectHttpsError(
          callAs(restoreDomain, {domainName: "tail-mirrored.com"}, uid),
        );

        const doc = await db().collection(COLLECTIONS.domains)
          .doc(`${uid}__tail-mirrored.com`).get();
        assert.equal(doc.data()?.lifecycle, "gone",
          "復旧できない状態を「解約手続き中」のまま見せないこと");
        assert.deepEqual(doc.data()?.rgpStatus, []);
      });

      it("keeps the delete markers when a lapsed restore is refused",
        async () => {
          // Nothing was undone, so nothing the delete recorded may be
          // dropped: a later reconciliation still needs them.
          const uid = await freshUid();
          await registerAndDelete(uid, "tail-markers.com");
          sign.endRedemptionPeriod("tail-markers.com");

          await expectHttpsError(
            callAs(restoreDomain, {domainName: "tail-markers.com"}, uid),
          );

          const doc = await db().collection(COLLECTIONS.domains)
            .doc(`${uid}__tail-markers.com`).get();
          assert.ok(doc.data()?.deletedAt);
          assert.equal(doc.data()?.autoRenewBeforeDelete, true);
        });
    });

  describe("the three ways restore can refuse", () => {
    it("2304: a live domain needs no restoring", async () => {
      const uid = await freshUid();
      await callAs(createOrder, {
        domainName: "still-live.com",
        idempotencyKey: testIdempotencyKey(),
      }, uid);

      const result = await callAs<LifecycleResponse>(
        restoreDomain, {domainName: "still-live.com"}, uid);

      assert.equal(result.lifecycle, "active");
      assert.equal(result.alreadyInState, true);
      assert.match(result.message, /復旧の必要はありません/);
    });

    it("404: the grace period has ended", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "too-late.com");
      sign.expireGracePeriod("too-late.com");

      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "too-late.com"}, uid),
      );
      assert.equal(code, "not-found");

      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__too-late.com`).get();
      assert.equal(doc.data()?.lifecycle, "gone",
        "失効を記録して一覧に反映すること");
    });

    it("403: the domain was transferred to another registrar", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "transferred-away.com");
      // A transfer moves the sponsorship, not the registrant: the contact id
      // on the domain is still this member's, so the ownership pre-check
      // passes and the registry itself answers 403.
      const ourRegistrant =
        sign.getDomain("transferred-away.com")?.registrant as string;
      sign.seedPendingDelete("transferred-away.com", ourRegistrant,
        "OTHER-REG");

      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "transferred-away.com"}, uid),
      );
      assert.equal(code, "permission-denied",
        "「設定不備」ではなく「権限が無い」と伝えること");
    });

    it("refuses to restore a name re-registered by someone else, without " +
      "even issuing the command", async () => {
      // Regression: A's domain expires, B re-registers the same name through
      // this service and deletes it. A blind restore would have resurrected
      // B's domain under A's click.
      const uid = await freshUid();
      await registerAndDelete(uid, "resurrect.com");
      sign.expireGracePeriod("resurrect.com");
      sign.seedPendingDelete("resurrect.com", "U999999");

      const code = await expectHttpsError(
        callAs(restoreDomain, {domainName: "resurrect.com"}, uid),
      );

      assert.equal(code, "not-found");
      assert.equal(
        sign.countCalls("POST", "/domains/resurrect.com/restore"), 0,
        "他人のドメインには restore コマンド自体を発行しないこと");
      assert.deepEqual(sign.getDomain("resurrect.com")?.status,
        ["pendingDelete"], "B のドメインの状態を変えないこと");

      const aRecord = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__resurrect.com`).get();
      assert.equal(aRecord.data()?.lifecycle, "gone");
      assert.notEqual(aRecord.data()?.registrant, "U999999",
        "B の registrant を A のレコードへ書き込まないこと");
    });

    it("tells the three cases apart", async () => {
      const uid = await freshUid();
      await registerAndDelete(uid, "case-late.com");
      sign.expireGracePeriod("case-late.com");
      const late = await expectHttpsError(
        callAs(restoreDomain, {domainName: "case-late.com"}, uid));

      await registerAndDelete(uid, "case-foreign.com");
      const caseRegistrant =
        sign.getDomain("case-foreign.com")?.registrant as string;
      sign.seedPendingDelete("case-foreign.com", caseRegistrant,
        "OTHER-REG");
      const foreign = await expectHttpsError(
        callAs(restoreDomain, {domainName: "case-foreign.com"}, uid));

      assert.notEqual(late, foreign);
      assert.equal(late, "not-found");
      assert.equal(foreign, "permission-denied");
    });
  });
});
