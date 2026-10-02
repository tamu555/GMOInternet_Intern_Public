/**
 * The circuit breaker (docs/仕様/registry-unavailable.md).
 *
 * The 60-second window cannot be waited out in a test, so these tests seed
 * the health document directly — an old `firstFailureAt` stands in for a
 * minute of real failures — and then drive the real EppClient against the
 * stub registry to prove the gate, the verdict and the recovery probe.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {Timestamp} from "firebase-admin/firestore";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  requireEmulator,
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
  OUTAGE_WINDOW_MS,
  PROBE_INTERVAL_MS,
  healthDocId,
  resetHealthCache,
} from "../../src/bridge/registryHealth";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** @return {FirebaseFirestore.DocumentReference} kitaqsign's health doc. */
function signHealthRef() {
  return db().collection(COLLECTIONS.counters)
    .doc(healthDocId("kitaqsign"));
}

describe("registryHealth", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;
  let client: EppClient;

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
    client = new EppClient("kitaqsign");
  });

  /** Removes the health docs this file wrote, so later files start clean. */
  async function deleteHealthDocs(): Promise<void> {
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqsign")).delete();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqnic")).delete();
  }

  after(async () => {
    await deleteHealthDocs();
    await cleanupTestData([], counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(async () => {
    sign.reset();
    nic.reset();
    resetHealthCache();
    await signHealthRef().delete();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqnic")).delete();
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

  it("opens the circuit once 503s span the outage window", async () => {
    // A streak that started over a minute ago — the stand-in for sixty
    // seconds of real 503s.
    await signHealthRef().set({
      state: "ok",
      consecutive503: 5,
      firstFailureAt: Timestamp.fromMillis(
        Date.now() - OUTAGE_WINDOW_MS - 1000),
      lastFailureAt: Timestamp.fromMillis(Date.now() - 1000),
      lastProbeAt: null,
    });
    sign.force503 = true;

    const error = await hello("APP-TEST-HEALTH-OPEN");

    assert.ok(error instanceof RegistryError);
    assert.equal(error.kind, "serviceUnavailable");
    assert.equal(error.circuitOpen, true,
      "60秒を超えて503が続いたら接続不能と判定する");
    const stored = (await signHealthRef().get()).data();
    assert.equal(stored?.state, "unavailable");
  });

  it("fails fast without touching the registry while open", async () => {
    await signHealthRef().set({
      state: "unavailable",
      consecutive503: 9,
      firstFailureAt: Timestamp.fromMillis(Date.now() - 120_000),
      lastFailureAt: Timestamp.fromMillis(Date.now() - 1000),
      // A fresh probe claim, so this call is inside the quiet interval.
      lastProbeAt: Timestamp.now(),
    });

    const error = await hello("APP-TEST-HEALTH-FAST");

    assert.ok(error instanceof RegistryError);
    assert.equal(error.kind, "serviceUnavailable");
    assert.equal(error.circuitOpen, true);
    assert.equal(sign.calls.length, 0,
      "判定済みのレジストリを叩き続けないこと");
  });

  it("lets one probe through after the interval and closes on success",
    async () => {
      await signHealthRef().set({
        state: "unavailable",
        consecutive503: 9,
        firstFailureAt: Timestamp.fromMillis(Date.now() - 120_000),
        lastFailureAt: Timestamp.fromMillis(Date.now() - 60_000),
        lastProbeAt: Timestamp.fromMillis(
          Date.now() - PROBE_INTERVAL_MS - 1000),
      });
      // The registry has recovered: the probe must find it and close the
      // circuit on its own, with no human resetting anything.
      sign.force503 = false;

      const answer = await hello("APP-TEST-HEALTH-PROBE");

      assert.ok(!(answer instanceof Error), "プローブは実リクエストを通す");
      assert.equal(sign.countCalls("GET", "/sessions/hello"), 1);
      const stored = (await signHealthRef().get()).data();
      assert.equal(stored?.state, "ok", "成功したプローブが回路を閉じる");

      const second = await hello("APP-TEST-HEALTH-AFTER");
      assert.ok(!(second instanceof Error),
        "回路が閉じた後は通常どおり通信できる");
    });
});
