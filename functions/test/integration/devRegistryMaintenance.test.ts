/**
 * `devRegistryMaintenance` — the dev panel's announced-maintenance lever
 * (docs/仕様/registry-unavailable.md §7).
 *
 * What matters: the callable writes the SAME record a real poll announcement
 * would (registryMaintenance.ts), so the gate blocks with `maintenance:true`
 * and no HTTP; the window always carries an end time (leftover-proof by
 * construction); and the callable is dead outside the emulator.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  callAs,
  expectHttpsError,
  requireEmulator,
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {devRegistryMaintenance} from "../../src/api/devRegistryMaintenance";
import {EppClient} from "../../src/bridge/eppClient";
import {RegistryError} from "../../src/bridge/errors";
import {
  healthDocId,
  resetHealthCache,
} from "../../src/bridge/registryHealth";
import {
  maintenanceDocId,
  resetMaintenanceCache,
  type MaintenanceSummary,
} from "../../src/bridge/registryMaintenance";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Answer shape of the callable. */
interface DevMaintenanceAnswer {
  maintenance: {kitaqsign: MaintenanceSummary; kitaqnic: MaintenanceSummary};
}

describe("devRegistryMaintenance", {skip: HAS_EMULATOR ? false : SKIP_REASON},
  () => {
    const sign = new StubRegistry("KQSGN", [".com", ".net"]);
    const nic = new StubRegistry("KQNIC", [".shop"]);
    let counters: CounterSnapshot;
    let previousEmulatorEnv: string | undefined;

    /** Removes the docs this file writes, so later files start clean. */
    async function deleteStateDocs(): Promise<void> {
      for (const registry of ["kitaqsign", "kitaqnic"] as const) {
        await db().collection(COLLECTIONS.counters)
          .doc(maintenanceDocId(registry)).delete();
        await db().collection(COLLECTIONS.counters)
          .doc(healthDocId(registry)).delete();
      }
    }

    before(async () => {
      await requireEmulator();
      useStubRegistries(await sign.start(), await nic.start());
      counters = await snapshotCounters();
      // The whole suite plays "inside the emulator"; one test flips it off.
      previousEmulatorEnv = process.env.FUNCTIONS_EMULATOR;
      process.env.FUNCTIONS_EMULATOR = "true";
    });

    after(async () => {
      if (previousEmulatorEnv === undefined) {
        delete process.env.FUNCTIONS_EMULATOR;
      } else {
        process.env.FUNCTIONS_EMULATOR = previousEmulatorEnv;
      }
      await deleteStateDocs();
      await cleanupTestData([], counters);
      await sign.stop();
      await nic.stop();
    });

    beforeEach(async () => {
      sign.reset();
      nic.reset();
      resetHealthCache();
      resetMaintenanceCache();
      await deleteStateDocs();
    });

    /**
     * One hello against kitaqsign, errors handed back instead of thrown.
     *
     * @param {string} clTRID Transaction id for the call.
     * @return {Promise<unknown>} The answer or the caught error.
     */
    function hello(clTRID: string): Promise<unknown> {
      return new EppClient("kitaqsign").send({
        command: "session:hello",
        method: "GET",
        path: "/sessions/hello",
        clTRID,
      }).catch((e: unknown) => e);
    }

    it("answers all-inactive when nothing was ever set", async () => {
      const answer = await callAs<DevMaintenanceAnswer>(
        devRegistryMaintenance, {action: "get"});

      assert.equal(answer.maintenance.kitaqsign.active, false);
      assert.equal(answer.maintenance.kitaqnic.active, false);
    });

    it("opens a bounded window that blocks commands without any HTTP",
      async () => {
        const before = Date.now();
        const answer = await callAs<DevMaintenanceAnswer>(
          devRegistryMaintenance,
          {action: "set", registry: "kitaqsign", durationMinutes: 15});

        assert.equal(answer.maintenance.kitaqsign.active, true);
        assert.ok(answer.maintenance.kitaqsign.windowEnd,
          "検証用の窓は必ず終了時刻を持つ(消し忘れ対策)");
        const endMs = Date.parse(
          answer.maintenance.kitaqsign.windowEnd as string);
        assert.ok(endMs >= before + 15 * 60_000 - 1000);
        assert.ok(endMs <= Date.now() + 15 * 60_000 + 1000);
        assert.equal(answer.maintenance.kitaqnic.active, false,
          "もう一方のレジストリは巻き添えにしない");

        const error = await hello("APP-TEST-DEVMAINT-BLOCK");
        assert.ok(error instanceof RegistryError);
        assert.equal(error.kind, "serviceUnavailable");
        assert.equal(error.maintenance, true,
          "poll告知と同じ記録なのでメンテナンスと言い切れる");
        assert.equal(sign.calls.length, 0,
          "注入はBRIDGE内で完結し、実レジストリにはリクエストが飛ばない");
      });

    it("clears the window and lets traffic through again", async () => {
      await callAs(devRegistryMaintenance,
        {action: "set", registry: "kitaqsign", durationMinutes: 15});

      const answer = await callAs<DevMaintenanceAnswer>(
        devRegistryMaintenance, {action: "clear", registry: "kitaqsign"});

      assert.equal(answer.maintenance.kitaqsign.active, false);
      const ok = await hello("APP-TEST-DEVMAINT-CLEARED");
      assert.ok(!(ok instanceof Error), "解除後は通常運転に戻る");
    });

    it("does not consume the probe slot when only reading state", async () => {
      // An unbounded window (as a real announcement without an end would
      // leave) probes on a timer; a status read must not steal that slot
      // (the 二重ゲート trap).
      await db().collection(COLLECTIONS.counters)
        .doc(maintenanceDocId("kitaqsign")).set({
          active: true,
          windowStart: null,
          windowEnd: null,
          msgId: null,
          msgType: "registry:maintenance",
          note: null,
          rawPayload: null,
          announcedAt: null,
          lastProbeAt: null,
          clearedAt: null,
          clearedBy: null,
        });

      await callAs<DevMaintenanceAnswer>(
        devRegistryMaintenance, {action: "get"});

      const stored = (await db().collection(COLLECTIONS.counters)
        .doc(maintenanceDocId("kitaqsign")).get()).data();
      assert.equal(stored?.lastProbeAt, null,
        "状態表示の読み取りはプローブ枠を消費しない");
    });

    it("rejects a bad registry name and a bad duration", async () => {
      assert.equal(await expectHttpsError(callAs(devRegistryMaintenance,
        {action: "set", registry: "not-a-registry", durationMinutes: 15})),
      "invalid-argument");
      assert.equal(await expectHttpsError(callAs(devRegistryMaintenance,
        {action: "set", registry: "kitaqsign", durationMinutes: 0})),
      "invalid-argument");
      assert.equal(await expectHttpsError(callAs(devRegistryMaintenance,
        {action: "set", registry: "kitaqsign"})),
      "invalid-argument");
    });

    it("refuses to run outside the emulator", async () => {
      delete process.env.FUNCTIONS_EMULATOR;
      try {
        const code = await expectHttpsError(
          callAs(devRegistryMaintenance, {action: "get"}));
        assert.equal(code, "failed-precondition");
      } finally {
        process.env.FUNCTIONS_EMULATOR = "true";
      }
    });
  });
