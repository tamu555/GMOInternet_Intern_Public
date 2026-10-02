/**
 * `sweepAutoRenewOff` — the auto-renew-OFF expiry batch (spec 6.4, TBD #15).
 *
 * The registry auto-renews every expired domain unconditionally and has no
 * OFF switch of its own (spec 3.6), so the sweep queries the app's own
 * `domains` mirror for `autoRenew: false` domains whose `exDate` has already
 * passed and deletes them through the same `deleteOwnedDomain` use case a
 * manual "解約" click goes through — the domain lands in the normal 45-day
 * RGP `redemptionPeriod`, it does not vanish.
 *
 * `autoRenew == false` and `lifecycle == active` are queried straight from
 * Firestore (two plain equality filters); `exDate` is compared in code
 * against an explicit `now` so tests never have to sleep. Because the query
 * has no `uid` filter, every `it()` below clears the candidate space first —
 * otherwise a domain left behind by an earlier test in this file would be
 * picked up again by a later one and throw the exact counts off.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  activeMemberUid,
  callAs,
  requireEmulator,
  testIdempotencyKey,
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
import {domainDocId} from "../../src/domain/domainRecords";
import {deleteOwnedDomain} from "../../src/domain/domainLifecycle";
import {sweepAutoRenewOff} from "../../src/domain/expirySweep";

describe("sweepAutoRenewOff", {skip: HAS_EMULATOR ? false : SKIP_REASON},
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

    beforeEach(async () => {
      sign.reset();
      nic.reset();
      resetTldCache();
      // The sweep's query is not uid-scoped, so any candidate left behind by
      // an earlier test in this file would otherwise be re-swept here too.
      const stale = await db().collection(COLLECTIONS.domains)
        .where("autoRenew", "==", false).get();
      await Promise.all(stale.docs.map((doc) => doc.ref.delete()));
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
     * Registers a domain through the real order flow, so the Firestore
     * record and the registry agree before the test starts.
     *
     * @param {string} uid Owner.
     * @param {string} name Domain to register.
     * @param {boolean} autoRenew Auto-renew choice at registration time.
     * @return {Promise<void>} Resolves once registered.
     */
    async function registerDomain(
      uid: string,
      name: string,
      autoRenew: boolean,
    ): Promise<void> {
      await callAs(createOrder, {
        domainName: name,
        idempotencyKey: testIdempotencyKey(),
        autoRenew,
      }, uid);
    }

    /**
     * Overwrites the mirror's `exDate`, independently of what the stub
     * registry itself reports — the sweep only ever reads `exDate` from
     * Firestore.
     *
     * @param {string} uid Owner.
     * @param {string} name Domain name.
     * @param {string} exDate ISO 8601 date to store.
     * @return {Promise<void>} Resolves once written.
     */
    async function setExDate(
      uid: string,
      name: string,
      exDate: string,
    ): Promise<void> {
      await db().collection(COLLECTIONS.domains)
        .doc(domainDocId(uid, name))
        .update({exDate});
    }

    it("deletes an auto-renew-off domain whose exDate has passed",
      async () => {
        const uid = await freshUid();
        await registerDomain(uid, "expired-off.com", false);
        await setExDate(uid, "expired-off.com", "2020-01-01T00:00:00Z");

        const result = await sweepAutoRenewOff({
          now: new Date("2026-01-01T00:00:00Z"),
        });

        assert.equal(result.deleted, 1);
        assert.equal(result.failures, 0);
        assert.equal(
          sign.countCalls("DELETE", "/domains/expired-off.com"), 1);
        const doc = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "expired-off.com")).get();
        assert.equal(doc.data()?.lifecycle, "pendingDelete");
      });

    it("leaves an auto-renew-off domain alone before its exDate",
      async () => {
        const uid = await freshUid();
        await registerDomain(uid, "not-yet-off.com", false);
        await setExDate(uid, "not-yet-off.com", "2099-01-01T00:00:00Z");

        const result = await sweepAutoRenewOff({
          now: new Date("2026-01-01T00:00:00Z"),
        });

        assert.equal(result.deleted, 0);
        assert.equal(
          sign.countCalls("DELETE", "/domains/not-yet-off.com"), 0);
        const doc = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "not-yet-off.com")).get();
        assert.equal(doc.data()?.lifecycle, "active");
      });

    it("leaves an auto-renew-on domain alone even past its exDate",
      async () => {
        const uid = await freshUid();
        await registerDomain(uid, "renews-on.com", true);
        await setExDate(uid, "renews-on.com", "2020-01-01T00:00:00Z");

        const result = await sweepAutoRenewOff({
          now: new Date("2026-01-01T00:00:00Z"),
        });

        assert.equal(result.deleted, 0);
        assert.equal(sign.countCalls("DELETE", "/domains/renews-on.com"), 0);
        const doc = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "renews-on.com")).get();
        assert.equal(doc.data()?.lifecycle, "active");
      });

    it("never selects a legacy record with no autoRenew flag at all",
      async () => {
        // No registerDomain here on purpose: a record predating the flag has
        // no stub-registered domain either, so if this were ever selected the
        // delete attempt would show up as a failure rather than silently
        // passing.
        const uid = await freshUid();
        await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "legacy-no-flag.com"))
          .set({
            uid,
            name: "legacy-no-flag.com",
            lifecycle: "active",
            exDate: "2020-01-01T00:00:00Z",
          });

        const result = await sweepAutoRenewOff({
          now: new Date("2026-01-01T00:00:00Z"),
        });

        assert.equal(result.deleted, 0);
        assert.equal(result.failures, 0);
        const doc = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "legacy-no-flag.com")).get();
        assert.equal(doc.data()?.lifecycle, "active");
      });

    it("does not re-delete a domain that is already pendingDelete",
      async () => {
        const uid = await freshUid();
        await registerDomain(uid, "already-deleting.com", false);
        await deleteOwnedDomain(uid, "already-deleting.com");
        const deletesBefore =
          sign.countCalls("DELETE", "/domains/already-deleting.com");

        const result = await sweepAutoRenewOff({
          now: new Date("2026-01-01T00:00:00Z"),
        });

        assert.equal(result.deleted, 0);
        assert.equal(
          sign.countCalls("DELETE", "/domains/already-deleting.com"),
          deletesBefore,
        );
        const doc = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "already-deleting.com")).get();
        assert.equal(doc.data()?.lifecycle, "pendingDelete");
      });

    it("isolates one domain's delete failure from the rest of the run",
      async () => {
        const uid = await freshUid();
        // Routed to `sign`, which is about to be made to time out.
        await registerDomain(uid, "flaky-off.com", false);
        await setExDate(uid, "flaky-off.com", "2020-01-01T00:00:00Z");
        // Routed to `nic`, left healthy.
        await registerDomain(uid, "healthy-off.shop", false);
        await setExDate(uid, "healthy-off.shop", "2020-01-01T00:00:00Z");

        process.env.REGISTRY_TIMEOUT_MS = "80";
        sign.delayMs = 400;
        let result;
        try {
          result = await sweepAutoRenewOff({
            now: new Date("2026-01-01T00:00:00Z"),
          });
        } finally {
          delete process.env.REGISTRY_TIMEOUT_MS;
          sign.delayMs = 0;
        }

        assert.equal(result.deleted, 1);
        assert.equal(result.failures, 1);
        const flaky = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "flaky-off.com")).get();
        assert.equal(flaky.data()?.lifecycle, "active",
          "失敗した削除で状態を進めないこと");
        const healthy = await db().collection(COLLECTIONS.domains)
          .doc(domainDocId(uid, "healthy-off.shop")).get();
        assert.equal(healthy.data()?.lifecycle, "pendingDelete");
        assert.equal(
          nic.countCalls("DELETE", "/domains/healthy-off.shop"), 1);
      });
  });
