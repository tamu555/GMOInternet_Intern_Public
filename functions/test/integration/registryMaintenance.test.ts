/**
 * Announced maintenance (registryMaintenance.ts).
 *
 * The lifecycle under test, end to end:
 *
 *   poll notification → window recorded → inside the window every command
 *   (polling included) fails fast with `maintenance: true` and NO probes →
 *   past the announced end traffic resumes → the first real answer clears
 *   the record.
 *
 * Windows cannot be waited out in a test, so most cases seed the Firestore
 * document directly — exactly like registryHealth.test.ts does for the
 * circuit breaker — and then drive the real EppClient / poll worker /
 * searchDomains against the stub registry.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {Timestamp} from "firebase-admin/firestore";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  callAs,
  requireEmulator,
  testUid,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {EppClient} from "../../src/bridge/eppClient";
import {RegistryError} from "../../src/bridge/errors";
import {
  healthDocId,
  resetHealthCache,
  PROBE_INTERVAL_MS,
} from "../../src/bridge/registryHealth";
import {
  maintenanceDocId,
  resetMaintenanceCache,
} from "../../src/bridge/registryMaintenance";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {
  clearPollHandlers,
  drainRegistryQueue,
} from "../../src/domain/pollWorker";
import {
  registerMaintenancePollHandlers,
} from "../../src/domain/maintenanceNotifications";
import {searchDomains} from "../../src/api/searchDomains";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Shape `searchDomains` answers with, maintenance fields included. */
interface SearchResult {
  results: {name: string; registry: string; available: boolean}[];
  unavailable: string[];
  maintenance: string[];
  maintenanceUntil: string | null;
}

/** @return {FirebaseFirestore.DocumentReference} kitaqsign's record. */
function signMaintenanceRef() {
  return db().collection(COLLECTIONS.counters)
    .doc(maintenanceDocId("kitaqsign"));
}

/**
 * Seeds an active maintenance record, as the poll handler would write it.
 *
 * @param {object} window Window bounds (either side optional).
 * @return {Promise<void>} Resolves once written.
 */
async function seedMaintenance(window: {
  startMs?: number;
  endMs?: number;
  lastProbeMs?: number;
}): Promise<void> {
  await signMaintenanceRef().set({
    active: true,
    windowStart: window.startMs !== undefined ?
      Timestamp.fromMillis(window.startMs) : null,
    windowEnd: window.endMs !== undefined ?
      Timestamp.fromMillis(window.endMs) : null,
    msgId: "1",
    msgType: "registry:maintenance",
    note: null,
    rawPayload: null,
    announcedAt: Timestamp.now(),
    lastProbeAt: window.lastProbeMs !== undefined ?
      Timestamp.fromMillis(window.lastProbeMs) : null,
    clearedAt: null,
    clearedBy: null,
  });
}

describe("registryMaintenance", {skip: HAS_EMULATOR ? false : SKIP_REASON},
  () => {
    const sign = new StubRegistry("KQSGN", [".com", ".net"]);
    const nic = new StubRegistry("KQNIC", [".shop"]);
    let counters: CounterSnapshot;
    let client: EppClient;
    const uid = testUid();

    before(async () => {
      await requireEmulator();
      useStubRegistries(await sign.start(), await nic.start());
      counters = await snapshotCounters();
      client = new EppClient("kitaqsign");
      sign.dialect = "kitaqsign";
      nic.dialect = "kitaqnic";
    });

    /** Removes the docs this file writes, so later files start clean. */
    async function deleteStateDocs(): Promise<void> {
      for (const registry of ["kitaqsign", "kitaqnic"] as const) {
        await db().collection(COLLECTIONS.counters)
          .doc(maintenanceDocId(registry)).delete();
        await db().collection(COLLECTIONS.counters)
          .doc(healthDocId(registry)).delete();
      }
      const stored = await db().collection(COLLECTIONS.pollMessages).get();
      await Promise.all(stored.docs.map((doc) => doc.ref.delete()));
    }

    after(async () => {
      await deleteStateDocs();
      await cleanupTestData([uid], counters);
      await sign.stop();
      await nic.stop();
    });

    beforeEach(async () => {
      const signDialect = sign.dialect;
      const nicDialect = nic.dialect;
      sign.reset();
      nic.reset();
      sign.dialect = signDialect;
      nic.dialect = nicDialect;
      resetHealthCache();
      resetMaintenanceCache();
      resetTldCache();
      clearPollHandlers();
      registerMaintenancePollHandlers();
      await deleteStateDocs();
    });

    /**
     * One hello against kitaqsign, errors handed back instead of thrown.
     *
     * @param {string} clTRID Transaction id for the call.
     * @return {Promise<unknown>} The answer or the caught error.
     */
    function hello(clTRID: string): Promise<unknown> {
      return client.send({
        command: "session:hello",
        method: "GET",
        path: "/sessions/hello",
        clTRID,
      }).catch((e: unknown) => e);
    }

    it("fails fast inside the window, without touching the registry",
      async () => {
        const endMs = Date.now() + 10 * 60_000;
        await seedMaintenance({startMs: Date.now() - 60_000, endMs});

        const error = await hello("APP-TEST-MAINT-BLOCK");

        assert.ok(error instanceof RegistryError);
        assert.equal(error.kind, "serviceUnavailable");
        assert.equal(error.maintenance, true,
          "告知された窓の中はメンテナンスと言い切る");
        assert.equal(error.maintenanceUntil,
          new Date(endMs).toISOString());
        assert.equal(error.circuitOpen, false,
          "メンテナンスは回路オープンとは別の判定");
        assert.equal(sign.calls.length, 0,
          "窓の中はプローブすら送らない");
      });

    it("sees a window recorded by another process, without a cold start",
      async () => {
        // First contact with no record caches "inactive" in this process...
        const ok = await hello("APP-TEST-MAINT-CACHE-1");
        assert.ok(!(ok instanceof Error));

        // ...then the window arrives via a DIFFERENT process (the poll
        // worker or the dev callable) — here simulated by a direct Firestore
        // write that this process's cache knows nothing about.
        await seedMaintenance({
          startMs: Date.now() - 60_000,
          endMs: Date.now() + 10 * 60_000,
        });

        const error = await hello("APP-TEST-MAINT-CACHE-2");
        assert.ok(error instanceof RegistryError,
          "キャッシュ済みの『メンテナンスなし』が新しい窓を隠してはいけない");
        assert.equal(error.maintenance, true);
      });

    it("lets traffic through before the announced start", async () => {
      await seedMaintenance({
        startMs: Date.now() + 60 * 60_000,
        endMs: Date.now() + 2 * 60 * 60_000,
      });

      const answer = await hello("APP-TEST-MAINT-PENDING");

      assert.ok(!(answer instanceof Error), "開始前は通常運転");
      const stored = (await signMaintenanceRef().get()).data();
      assert.equal(stored?.active, true,
        "開始前の疎通は告知を取り消す証拠にならない");
    });

    it("resumes past the announced end and clears on the first answer",
      async () => {
        await seedMaintenance({
          startMs: Date.now() - 2 * 60 * 60_000,
          endMs: Date.now() - 60_000,
        });

        const answer = await hello("APP-TEST-MAINT-OVER");

        assert.ok(!(answer instanceof Error), "窓が明けたら再接続する");
        const stored = (await signMaintenanceRef().get()).data();
        assert.equal(stored?.active, false,
          "疎通が確認できた時点で解除する");
        assert.equal(stored?.clearedBy, "contact");
      });

    it("probes a window with no announced end, and clears on success",
      async () => {
        await seedMaintenance({startMs: Date.now() - 60_000});

        // Probe slot still warm: fail fast.
        await signMaintenanceRef().set(
          {lastProbeAt: Timestamp.now()}, {merge: true});
        const blocked = await hello("APP-TEST-MAINT-NOEND-1");
        assert.ok(blocked instanceof RegistryError);
        assert.equal(blocked.maintenance, true);
        assert.equal(blocked.maintenanceUntil, null);
        assert.equal(sign.calls.length, 0);

        // Probe interval elapsed: one request goes through and, answered,
        // retires the record.
        await signMaintenanceRef().set(
          {lastProbeAt: Timestamp.fromMillis(
            Date.now() - PROBE_INTERVAL_MS - 1000)},
          {merge: true});
        const answer = await hello("APP-TEST-MAINT-NOEND-2");
        assert.ok(!(answer instanceof Error));
        const stored = (await signMaintenanceRef().get()).data();
        assert.equal(stored?.active, false);
      });

    it("labels a skipped poll run as maintenance, not an error", async () => {
      await seedMaintenance({endMs: Date.now() + 10 * 60_000});

      const run = await drainRegistryQueue("kitaqsign");

      assert.equal(run.stoppedBecause, "maintenance");
      assert.equal(run.error, undefined);
      assert.equal(sign.calls.length, 0,
        "窓の中はpollも送らない");
    });

    it("records a window announced over the poll queue", async () => {
      const start = "2026-08-30T01:00:00.000Z";
      const end = "2026-08-30T03:00:00.000Z";
      sign.enqueueMessage("registry:maintenance",
        {start, end, message: "定期メンテナンス"});

      const run = await drainRegistryQueue("kitaqsign");

      assert.equal(run.polled, 1);
      assert.equal(run.handlerFailures, 0);
      const stored = (await signMaintenanceRef().get()).data();
      assert.equal(stored?.active, true);
      assert.equal(stored?.windowStart?.toDate().toISOString(), start);
      assert.equal(stored?.windowEnd?.toDate().toISOString(), end);
      assert.equal(stored?.note, "定期メンテナンス");
    });

    it("claims an unforeseen spelling through the keyword fallback",
      async () => {
        sign.enqueueMessage("system.maintenance.scheduled.v2",
          {windowEnd: "2026-08-30T03:00:00Z"});

        await drainRegistryQueue("kitaqsign");

        const stored = (await signMaintenanceRef().get()).data();
        assert.equal(stored?.active, true,
          "登録済みの綴りでなくてもmaintenanceを含む型は拾う");
      });

    it("clears the record on an end-of-maintenance notification",
      async () => {
        // No announced end: the poll itself is the probe that stays allowed.
        await seedMaintenance({
          startMs: Date.now() - 60_000,
          lastProbeMs: Date.now() - PROBE_INTERVAL_MS - 1000,
        });
        sign.enqueueMessage("registry:maintenance", {status: "completed"});

        const run = await drainRegistryQueue("kitaqsign");

        assert.equal(run.polled, 1);
        const stored = (await signMaintenanceRef().get()).data();
        assert.equal(stored?.active, false);
        assert.equal(stored?.clearedBy, "notification");
      });

    it("searchDomains reports the affected names as maintenance", async () => {
      const endMs = Date.now() + 10 * 60_000;
      await seedMaintenance({startMs: Date.now() - 60_000, endMs});

      const result = await callAs<SearchResult>(searchDomains,
        {names: ["maint.com", "maint.shop"]}, uid);

      assert.deepEqual(result.maintenance, ["maint.com"],
        "窓の中のレジストリのTLDはmaintenanceに入る");
      assert.equal(result.maintenanceUntil, new Date(endMs).toISOString());
      assert.deepEqual(result.unavailable, [],
        "メンテナンスは接続不能(unavailable)とは区別する");
      assert.equal(result.results.length, 1,
        "もう一方のレジストリは巻き添えにしない");
      assert.equal(result.results[0]?.name, "maint.shop");
    });
  });
