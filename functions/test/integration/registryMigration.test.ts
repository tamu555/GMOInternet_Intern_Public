/**
 * A domain that changed registry underneath its mirror.
 *
 * `domains/{uid}__{name}` stores the registry the domain was provisioned at.
 * When a registry hands a TLD over to the other one, that field is wrong for
 * every domain in the TLD — and the registry it names answers `domain:info`
 * with an entirely honest 404. Delete and restore used to read that 404 as
 * "the name was purged" and write `gone` into the mirror, erasing the record
 * of a domain that is alive at the other registry.
 *
 * The whole suite is about that one confusion. Every gone-write is now
 * preceded by a `domain:info` against the OTHER registry, and these tests pin
 * all five answers it can come back with: it is ours over there (heal, ask the
 * member to retry), it is somebody else's, it is nowhere, the TLD is not
 * served there, and the probe itself failed.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  callAs,
  expectHttpsError,
  requireEmulator,
  testIdempotencyKey,
  activeMemberUid,
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
import {healthDocId, resetHealthCache} from "../../src/bridge/registryHealth";
import {COLLECTIONS, db} from "../../src/config/firebase";

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

describe("registry migration", {skip: HAS_EMULATOR ? false : SKIP_REASON},
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
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqsign")).delete();
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqnic")).delete();
      await sign.stop();
      await nic.stop();
    });

    beforeEach(async () => {
      sign.reset();
      nic.reset();
      resetTldCache();
      resetHealthCache();
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqnic")).delete();
    });

    /**
     * Allocates an active member uid that will be cleaned up afterwards.
     *
     * The user document is seeded because `requireActiveUser`
     * (src/auth/callerGuard.ts) rejects any caller who does not hold an
     * active one, and every Callable this suite drives goes through it.
     *
     * @return {Promise<string>} Test uid backed by an active user document.
     */
    async function freshUid(): Promise<string> {
      const uid = await activeMemberUid();
      uids.push(uid);
      return uid;
    }

    /**
     * Registers a domain through the real order flow, so the mirror and the
     * registry agree before the migration is played.
     *
     * @param {string} uid Owner.
     * @param {string} name Domain to register.
     * @return {Promise<string>} The registrant contact id on the domain.
     */
    async function registerDomain(
      uid: string,
      name: string,
    ): Promise<string> {
      await callAs(createOrder, {
        domainName: name,
        idempotencyKey: testIdempotencyKey(),
      }, uid);
      return sign.getDomain(name)?.registrant as string;
    }

    /**
     * Reads back the domain mirror.
     *
     * @param {string} uid Owner.
     * @param {string} name Domain name.
     * @return {Promise<FirebaseFirestore.DocumentData>} Stored fields.
     */
    async function mirror(
      uid: string,
      name: string,
    ): Promise<FirebaseFirestore.DocumentData> {
      const doc = await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__${name}`).get();
      return doc.data() ?? {};
    }

    describe("A: the domain lives at the other registry", () => {
      it("heals the mirror instead of writing off a delete's 404",
        async () => {
          const uid = await freshUid();
          const name = "moved-delete.com";
          const registrant = await registerDomain(uid, name);
          // The registry-side move: kitaqnic holds it now, kitaqsign has
          // never heard of it. Our mirror still says kitaqsign.
          nic.seedDomain(name, registrant);
          sign.expireGracePeriod(name);

          const code = await expectHttpsError(
            callAs(deleteDomain, {domainName: name}, uid));

          assert.equal(code, "unavailable",
            "「もう一度お試しください」と伝える再試行可能なエラーであること");
          const healed = await mirror(uid, name);
          assert.notEqual(healed.lifecycle, "gone",
            "生きているドメインを失効として記録しないこと");
          assert.equal(healed.registry, "kitaqnic",
            "実際にドメインを保持しているレジストリへ張り替えること");
          assert.deepEqual(healed.status, ["inactive"],
            "状態も移動先レジストリの回答で上書きすること");
          assert.equal(healed.exDate, "2027-08-01T00:00:00Z");
        });

      it("lets the very next attempt succeed, against the right registry",
        async () => {
          const uid = await freshUid();
          const name = "retry-delete.com";
          const registrant = await registerDomain(uid, name);
          nic.seedDomain(name, registrant);
          sign.expireGracePeriod(name);

          await expectHttpsError(
            callAs(deleteDomain, {domainName: name}, uid));
          const signDeletes = sign.countCalls("DELETE", `/domains/${name}`);

          const result = await callAs<LifecycleResponse>(
            deleteDomain, {domainName: name}, uid);

          assert.equal(result.lifecycle, "pendingDelete");
          assert.equal(result.registry, "kitaqnic");
          assert.equal(nic.countCalls("DELETE", `/domains/${name}`), 1);
          assert.equal(sign.countCalls("DELETE", `/domains/${name}`),
            signDeletes, "旧レジストリへ二度目の delete を送らないこと");
          assert.ok(
            nic.getDomain(name)?.status.includes("pendingDelete"),
            "移動先のドメインが実際に解約手続きへ入ること");
        });

      it("heals when a stale mirror's refresh read comes back empty",
        async () => {
          // delete's other gone-write: the record already says
          // pendingDelete, so delete re-reads before acting — and that read
          // is the one that 404s at the wrong registry.
          const uid = await freshUid();
          const name = "stale-refresh.com";
          const registrant = await registerDomain(uid, name);
          await callAs(deleteDomain, {domainName: name}, uid);
          nic.seedPendingDelete(name, registrant);
          sign.expireGracePeriod(name);

          const code = await expectHttpsError(
            callAs(deleteDomain, {domainName: name}, uid));

          assert.equal(code, "unavailable");
          const healed = await mirror(uid, name);
          assert.equal(healed.lifecycle, "pendingDelete");
          assert.equal(healed.registry, "kitaqnic");
        });

      it("heals instead of refusing a restore that found nothing",
        async () => {
          const uid = await freshUid();
          const name = "moved-restore.com";
          const registrant = await registerDomain(uid, name);
          await callAs(deleteDomain, {domainName: name}, uid);
          nic.seedPendingDelete(name, registrant);
          sign.expireGracePeriod(name);

          const code = await expectHttpsError(
            callAs(restoreDomain, {domainName: name}, uid));

          assert.equal(code, "unavailable",
            "「猶予期間が終了しました」と言い切らないこと");
          const healed = await mirror(uid, name);
          assert.equal(healed.lifecycle, "pendingDelete");
          assert.equal(healed.registry, "kitaqnic");
          assert.equal(
            sign.countCalls("POST", `/domains/${name}/restore`), 0);

          const result = await callAs<LifecycleResponse>(
            restoreDomain, {domainName: name}, uid);
          assert.equal(result.lifecycle, "active");
          assert.equal(result.registry, "kitaqnic");
          assert.equal(nic.countCalls("POST", `/domains/${name}/restore`), 1);
        });

      it("heals when the restore command itself answers 404", async () => {
        // The fourth gone-write: the pre-read succeeded, and the name was
        // purged between it and the command. Here that "purge" is the old
        // registry losing the TLD while the domain lives on at the new one.
        const uid = await freshUid();
        const name = "restore-404.com";
        const registrant = await registerDomain(uid, name);
        await callAs(deleteDomain, {domainName: name}, uid);
        nic.seedPendingDelete(name, registrant);
        sign.expireAfterNextInfo(name);

        const code = await expectHttpsError(
          callAs(restoreDomain, {domainName: name}, uid));

        assert.equal(code, "unavailable");
        assert.equal(sign.countCalls("POST", `/domains/${name}/restore`), 1,
          "前提: restore そのものが 404 を受け取っていること");
        const healed = await mirror(uid, name);
        assert.equal(healed.lifecycle, "pendingDelete");
        assert.equal(healed.registry, "kitaqnic");
      });

      it("re-points the unfinished orders of the same domain", async () => {
        // Without this, renewDomain's lease transaction sees
        // domain.registry !== order.registry and fails the order outright.
        const uid = await freshUid();
        const name = "order-heal.com";
        const registrant = await registerDomain(uid, name);
        const open = db().collection(COLLECTIONS.orders)
          .doc(`${uid}__open-renew`);
        const finished = db().collection(COLLECTIONS.orders)
          .doc(`${uid}__finished-renew`);
        await open.set({
          uid, seq: 900001, kind: "renew", domainName: name,
          registry: "kitaqsign", periodYears: 1, nameservers: [],
          priceYen: 1500, state: "paid", attempts: 0,
          idempotencyKey: "open-renew",
        });
        await finished.set({
          uid, seq: 900002, kind: "renew", domainName: name,
          registry: "kitaqsign", periodYears: 1, nameservers: [],
          priceYen: 1500, state: "done", attempts: 1,
          idempotencyKey: "finished-renew",
        });
        nic.seedDomain(name, registrant);
        sign.expireGracePeriod(name);

        await expectHttpsError(callAs(deleteDomain, {domainName: name}, uid));

        assert.equal((await open.get()).data()?.registry, "kitaqnic",
          "更新レースの整合性チェックが壊れないよう注文も張り替えること");
        assert.equal((await finished.get()).data()?.registry, "kitaqsign",
          "完了済みの注文は当時の記録として書き換えないこと");
      });
    });

    describe("B: the other registry has it under someone else", () => {
      it("still writes gone, and copies nothing of the new owner",
        async () => {
          const uid = await freshUid();
          const name = "recycled-elsewhere.com";
          const ourRegistrant = await registerDomain(uid, name);
          // Same name, another member's registrant: never resurrect it, and
          // never adopt its data into this record.
          nic.seedDomain(name, "U999999");
          sign.expireGracePeriod(name);

          const result = await callAs<LifecycleResponse>(
            deleteDomain, {domainName: name}, uid);

          assert.equal(result.lifecycle, "gone");
          assert.equal(result.alreadyInState, true);
          const written = await mirror(uid, name);
          assert.equal(written.lifecycle, "gone");
          assert.equal(written.registry, "kitaqsign",
            "他人のドメインの所在で自分の記録を書き換えないこと");
          assert.equal(written.registrant, ourRegistrant);
          assert.equal(nic.countCalls("DELETE", `/domains/${name}`), 0);
        });
    });

    describe("C: no registry has it any more", () => {
      it("writes gone, exactly as before this check existed", async () => {
        const uid = await freshUid();
        const name = "purged-everywhere.com";
        await registerDomain(uid, name);
        sign.expireGracePeriod(name);

        const result = await callAs<LifecycleResponse>(
          deleteDomain, {domainName: name}, uid);

        assert.equal(result.lifecycle, "gone");
        assert.equal((await mirror(uid, name)).lifecycle, "gone");
        assert.equal(nic.countCalls("GET", `/domains/${name}`), 1,
          "もう一方のレジストリに一度だけ問い合わせること");
      });
    });

    describe("D: the other registry does not serve the TLD", () => {
      it("writes gone: a refusal about the TLD says nothing about the name",
        async () => {
          // The normal-times shape. .com asked of the registry that serves
          // only .shop answers 「TLD ポリシー違反」 (422 / 2306), so the
          // original 404 stands and behaviour is unchanged.
          const uid = await freshUid();
          const name = "unsupported-there.com";
          await registerDomain(uid, name);
          sign.expireGracePeriod(name);
          nic.enforceTldPolicy = true;

          const result = await callAs<LifecycleResponse>(
            deleteDomain, {domainName: name}, uid);

          assert.equal(result.lifecycle, "gone");
          assert.equal((await mirror(uid, name)).lifecycle, "gone");
          const probe = nic.calls.find((call) =>
            call.method === "GET" && call.path === `/domains/${name}`);
          assert.match(probe?.clTRID ?? "", /^DOM-PROBE-/,
            "確認用の問い合わせと分かる clTRID を使うこと");
        });
    });

    describe("E: the other registry could not be asked", () => {
      it("writes nothing at all, and asks the member to try again",
        async () => {
          const uid = await freshUid();
          const name = "unverifiable.com";
          await registerDomain(uid, name);
          sign.expireGracePeriod(name);
          nic.force503 = true;

          const code = await expectHttpsError(
            callAs(deleteDomain, {domainName: name}, uid));

          assert.equal(code, "unavailable");
          const untouched = await mirror(uid, name);
          assert.equal(untouched.lifecycle, "active",
            "確認できないまま失効を書き込まないこと");
          assert.equal(untouched.registry, "kitaqsign");
        });

      it("keeps a restore's record intact too", async () => {
        const uid = await freshUid();
        const name = "unverifiable-restore.com";
        await registerDomain(uid, name);
        await callAs(deleteDomain, {domainName: name}, uid);
        sign.expireGracePeriod(name);
        nic.force503 = true;

        const code = await expectHttpsError(
          callAs(restoreDomain, {domainName: name}, uid));

        assert.equal(code, "unavailable");
        const untouched = await mirror(uid, name);
        assert.equal(untouched.lifecycle, "pendingDelete");
        assert.equal(untouched.registry, "kitaqsign");
      });
    });
  });
