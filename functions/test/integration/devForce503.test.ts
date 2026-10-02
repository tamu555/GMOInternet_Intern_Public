/**
 * `devForceRegistry503` — the dev panel's 503 fault injection
 * (docs/仕様/registry-unavailable.md; spec §10.2 故障注入スイッチ).
 *
 * Two properties matter: the flag must short-circuit inside the BRIDGE layer
 * (no HTTP ever reaches the registry, everything downstream sees a real
 * 503), and the callable must be dead outside the emulator.
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
import {devForceRegistry503} from "../../src/api/devForceRegistry503";
import {EppClient} from "../../src/bridge/eppClient";
import {RegistryError} from "../../src/bridge/errors";
import {
  healthDocId,
  resetHealthCache,
} from "../../src/bridge/registryHealth";
import {FORCE_503_DOC, FORCE_503_TTL_MS} from "../../src/dev/force503Flag";
import {COLLECTIONS, db} from "../../src/config/firebase";
import {Timestamp} from "firebase-admin/firestore";

/** Answer shape of the callable. */
interface DevForce503Answer {
  flags: {kitaqsign: boolean; kitaqnic: boolean};
  expiresAt: {kitaqsign: string | null; kitaqnic: string | null};
  health: Record<string, "ok" | "unavailable">;
}

describe("devForceRegistry503", {skip: HAS_EMULATOR ? false : SKIP_REASON},
  () => {
    const sign = new StubRegistry("KQSGN", [".com", ".net"]);
    const nic = new StubRegistry("KQNIC", [".shop"]);
    let counters: CounterSnapshot;
    let previousEmulatorEnv: string | undefined;

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
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqsign")).delete();
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqnic")).delete();
      await db().collection(COLLECTIONS.counters).doc(FORCE_503_DOC).delete();
      await cleanupTestData([], counters);
      await sign.stop();
      await nic.stop();
    });

    beforeEach(async () => {
      sign.reset();
      nic.reset();
      resetHealthCache();
      await db().collection(COLLECTIONS.counters).doc(FORCE_503_DOC).delete();
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqsign")).delete();
      await db().collection(COLLECTIONS.counters)
        .doc(healthDocId("kitaqnic")).delete();
    });

    it("answers all-off flags when nothing was ever set", async () => {
      const answer = await callAs<DevForce503Answer>(
        devForceRegistry503, {action: "get"});

      assert.deepEqual(answer.flags, {kitaqsign: false, kitaqnic: false});
      assert.deepEqual(answer.health,
        {kitaqsign: "ok", kitaqnic: "ok"});
    });

    it("sets one registry's flag and reads it back", async () => {
      const answer = await callAs<DevForce503Answer>(devForceRegistry503,
        {action: "set", registry: "kitaqnic", enabled: true});

      assert.deepEqual(answer.flags, {kitaqsign: false, kitaqnic: true});
    });

    it("stamps an expiry when switched on, so the flag dies on its own",
      async () => {
        const before = Date.now();
        const answer = await callAs<DevForce503Answer>(devForceRegistry503,
          {action: "set", registry: "kitaqnic", enabled: true});

        assert.ok(answer.expiresAt.kitaqnic,
          "ONのフラグは自動OFF時刻を持つ");
        const expiresMs = Date.parse(answer.expiresAt.kitaqnic as string);
        assert.ok(expiresMs >= before + FORCE_503_TTL_MS - 1000);
        assert.ok(expiresMs <= Date.now() + FORCE_503_TTL_MS + 1000);
        assert.equal(answer.expiresAt.kitaqsign, null,
          "OFFのフラグに自動OFF時刻はない");
      });

    it("treats an expired flag as off", async () => {
      await db().collection(COLLECTIONS.counters).doc(FORCE_503_DOC).set({
        kitaqsign: true,
        kitaqsignExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
      });

      const answer = await callAs<DevForce503Answer>(
        devForceRegistry503, {action: "get"});

      assert.deepEqual(answer.flags, {kitaqsign: false, kitaqnic: false},
        "期限を過ぎたフラグは読み取り時にOFF扱いになる");
    });

    it("treats a legacy flag without an expiry as off (stale snapshots)",
      async () => {
        // The shape old emulator exports can resurrect: flag on, no expiry.
        await db().collection(COLLECTIONS.counters).doc(FORCE_503_DOC)
          .set({kitaqsign: true});

        const answer = await callAs<DevForce503Answer>(
          devForceRegistry503, {action: "get"});

        assert.deepEqual(answer.flags, {kitaqsign: false, kitaqnic: false},
          "expiresAtのない旧形式のフラグは自己修復的にOFF扱いになる");
      });

    it("makes the BRIDGE answer 503 without any HTTP reaching the registry",
      async () => {
        await callAs(devForceRegistry503,
          {action: "set", registry: "kitaqsign", enabled: true});

        const error = await new EppClient("kitaqsign").send({
          command: "session:hello",
          method: "GET",
          path: "/sessions/hello",
          clTRID: "APP-TEST-FORCED",
        }).catch((e: unknown) => e);

        assert.ok(error instanceof RegistryError);
        assert.equal(error.kind, "serviceUnavailable");
        assert.equal(error.httpStatus, 503);
        assert.equal(sign.calls.length, 0,
          "注入はBRIDGE内で完結し、実レジストリにはリクエストが飛ばない");
      });

    it("rejects a bad registry name", async () => {
      const code = await expectHttpsError(callAs(devForceRegistry503,
        {action: "set", registry: "not-a-registry", enabled: true}));
      assert.equal(code, "invalid-argument");
    });

    it("refuses to run outside the emulator", async () => {
      delete process.env.FUNCTIONS_EMULATOR;
      try {
        const code = await expectHttpsError(
          callAs(devForceRegistry503, {action: "get"}));
        assert.equal(code, "failed-precondition");
      } finally {
        process.env.FUNCTIONS_EMULATOR = "true";
      }
    });
  });
