/**
 * The shared HTTP client (spec 4.4).
 *
 * This is where the two-stage judgement lives, so these tests deliberately
 * cover the combinations that a single-stage check would get wrong: a 2xx
 * carrying a business failure, and a business success code carried by a
 * status the client must still accept.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  HAS_EMULATOR,
  SKIP_REASON,
  TEST_GATE_PASSWORD,
  TEST_GATE_USER,
  TEST_KITAQNIC_API_KEY,
  TEST_KITAQSIGN_API_KEY,
  TEST_REGISTRAR_ID,
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
  healthDocId,
  resetHealthCache,
} from "../../src/bridge/registryHealth";
import {EPP_RESULT} from "../../src/bridge/types";
import {COLLECTIONS, db} from "../../src/config/firebase";

describe("EppClient", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
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
    // Health judgement must not leak between tests: clear both the process
    // cache and the Firestore records (docs/仕様/registry-unavailable.md).
    resetHealthCache();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqsign")).delete();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqnic")).delete();
  });

  it("attaches both authentication layers and the clTRID", async () => {
    await client.send({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID: "APP-TEST-HEADERS",
      idempotent: true,
    });

    const call = sign.calls[sign.calls.length - 1];
    const expected = Buffer
      .from(`${TEST_GATE_USER}:${TEST_GATE_PASSWORD}`)
      .toString("base64");
    assert.equal(call?.authorization, `Basic ${expected}`);
    assert.equal(call?.registrarId, TEST_REGISTRAR_ID);
    assert.equal(call?.apiKey, TEST_KITAQSIGN_API_KEY);
    assert.equal(call?.clTRID, "APP-TEST-HEADERS");
  });

  it("sends each registry its own API key", async () => {
    await client.send({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID: "APP-TEST-KEY-SIGN",
      idempotent: true,
    });
    await new EppClient("kitaqnic").send({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID: "APP-TEST-KEY-NIC",
      idempotent: true,
    });

    assert.equal(sign.calls[sign.calls.length - 1]?.apiKey,
      TEST_KITAQSIGN_API_KEY);
    assert.equal(nic.calls[nic.calls.length - 1]?.apiKey,
      TEST_KITAQNIC_API_KEY);
  });

  it("shares one Basic gate and one registrar id across registries",
    async () => {
      await new EppClient("kitaqnic").send({
        command: "session:hello",
        method: "GET",
        path: "/sessions/hello",
        clTRID: "APP-TEST-SHARED",
        idempotent: true,
      });

      const call = nic.calls[nic.calls.length - 1];
      const expected = Buffer
        .from(`${TEST_GATE_USER}:${TEST_GATE_PASSWORD}`)
        .toString("base64");
      assert.equal(call?.authorization, `Basic ${expected}`);
      assert.equal(call?.registrarId, TEST_REGISTRAR_ID);
    });

  it("accepts a 2xx carrying result 1000", async () => {
    const answer = await client.send<{results: unknown[]}>({
      command: "domain:check",
      method: "POST",
      path: "/domains/check",
      body: {names: ["free.com"]},
      clTRID: "APP-TEST-CHECK",
      idempotent: true,
    });
    assert.equal(answer.resultCode, EPP_RESULT.SUCCESS);
    assert.equal(answer.tolerated, false);
    assert.ok(answer.svTRID.length > 0);
  });

  it("rejects a business failure even though the transport succeeded",
    async () => {
      sign.seedContact("U000001");
      sign.seedDomain("taken.com", "U000001");

      const error = await client.send({
        command: "domain:create",
        method: "POST",
        path: "/domains",
        body: {
          domain: "taken.com",
          registrant: "U000001",
          period: {unit: "Y", value: 1},
          authInfo: "pass",
        },
        clTRID: "APP-TEST-DUP",
      }).catch((e: unknown) => e);

      assert.ok(error instanceof RegistryError);
      assert.equal(error.kind, "objectExists");
      assert.equal(error.resultCode, EPP_RESULT.OBJECT_EXISTS);
      assert.equal(error.retryable, false);
    });

  it("hands a tolerated result code back instead of throwing", async () => {
    sign.seedContact("U000001");
    sign.seedDomain("taken.com", "U000001");

    const answer = await client.send({
      command: "domain:create",
      method: "POST",
      path: "/domains",
      body: {
        domain: "taken.com",
        registrant: "U000001",
        period: {unit: "Y", value: 1},
        authInfo: "pass",
      },
      clTRID: "APP-TEST-TOLERATE",
      tolerate: [EPP_RESULT.OBJECT_EXISTS],
    });

    assert.equal(answer.resultCode, EPP_RESULT.OBJECT_EXISTS);
    assert.equal(answer.tolerated, true);
  });

  it("classifies a missing object as objectNotFound", async () => {
    const error = await client.send({
      command: "domain:info",
      method: "GET",
      path: "/domains/missing.com",
      clTRID: "APP-TEST-404",
      idempotent: true,
    }).catch((e: unknown) => e);

    assert.ok(error instanceof RegistryError);
    assert.equal(error.kind, "objectNotFound");
  });

  it("retries a 5xx for an idempotent command", async () => {
    sign.helloFails = true;
    const error = await client.send({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID: "APP-TEST-RETRY",
      idempotent: true,
    }).catch((e: unknown) => e);

    assert.ok(error instanceof RegistryError);
    assert.equal(error.kind, "transport");
    assert.equal(sign.countCalls("GET", "/sessions/hello"), 3);
  });

  it("treats a fresh 503 as serviceUnavailable with the circuit closed",
    async () => {
      sign.force503 = true;
      const error = await client.send({
        command: "session:hello",
        method: "GET",
        path: "/sessions/hello",
        clTRID: "APP-TEST-503",
        idempotent: true,
      }).catch((e: unknown) => e);

      assert.ok(error instanceof RegistryError);
      assert.equal(error.kind, "serviceUnavailable");
      assert.equal(error.retryable, true,
        "503は未実行が保証されるので冪等コマンドは再送してよい");
      assert.equal(error.circuitOpen, false,
        "1リクエスト内の503連発だけでは接続不能と判定しない（60秒窓）");
      assert.equal(sign.countCalls("GET", "/sessions/hello"), 3);
    });

  it("never retries a command that is not marked idempotent", async () => {
    sign.seedContact("U000001");
    sign.failNextCreates(3, 500);

    const error = await client.send({
      command: "domain:create",
      method: "POST",
      path: "/domains",
      body: {
        domain: "once.com",
        registrant: "U000001",
        period: {unit: "Y", value: 1},
        authInfo: "pass",
      },
      clTRID: "APP-TEST-NORETRY",
    }).catch((e: unknown) => e);

    assert.ok(error instanceof RegistryError);
    assert.equal(error.retryable, true);
    assert.equal(sign.countCalls("POST", "/domains"), 1,
      "create は自動再送してはいけない");
  });

  it("aborts a stalled registry instead of hanging", async () => {
    // The real budget is 10s; shortening it here is the only way to reach the
    // abort path in a test that finishes quickly.
    process.env.REGISTRY_TIMEOUT_MS = "150";
    sign.delayMs = 1500;
    try {
      const started = Date.now();
      const error = await client.send({
        command: "session:hello",
        method: "GET",
        path: "/sessions/hello",
        clTRID: "APP-TEST-SLOW",
      }).catch((e: unknown) => e);

      assert.ok(error instanceof RegistryError);
      assert.equal(error.kind, "transport");
      assert.equal(error.retryable, true);
      assert.ok(Date.now() - started < 1200,
        "レジストリの応答より先に fetch 側が諦めること");
    } finally {
      delete process.env.REGISTRY_TIMEOUT_MS;
      sign.delayMs = 0;
    }
  });

  it("does not abort a call that answers within the budget", async () => {
    sign.delayMs = 50;
    const answer = await client.send({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID: "APP-TEST-INBUDGET",
    });
    assert.equal(answer.resultCode, EPP_RESULT.SUCCESS);
  });

  it("logs the investigation keys for a successful command", async () => {
    await client.send({
      command: "domain:check",
      method: "POST",
      path: "/domains/check",
      body: {names: ["logged.com"]},
      clTRID: "APP-TEST-LOG-OK",
      idempotent: true,
    });

    const rows = await db().collection(COLLECTIONS.registryLogs)
      .where("clTRID", "==", "APP-TEST-LOG-OK").get();
    assert.equal(rows.size, 1);
    const row = rows.docs[0].data();
    assert.equal(row.ok, true);
    assert.equal(row.registry, "kitaqsign");
    assert.equal(row.resultCode, EPP_RESULT.SUCCESS);
    assert.ok(String(row.svTRID).length > 0);
    assert.equal(typeof row.durationMs, "number");
  });

  it("logs failures too, with the classification", async () => {
    await client.send({
      command: "domain:info",
      method: "GET",
      path: "/domains/missing.com",
      clTRID: "APP-TEST-LOG-NG",
    }).catch(() => undefined);

    const rows = await db().collection(COLLECTIONS.registryLogs)
      .where("clTRID", "==", "APP-TEST-LOG-NG").get();
    assert.equal(rows.size, 1);
    assert.equal(rows.docs[0].data().ok, false);
    assert.equal(rows.docs[0].data().errorKind, "objectNotFound");
  });
});
