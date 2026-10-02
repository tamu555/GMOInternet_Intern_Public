/**
 * `searchDomains` — the step before the order form in FIG.1.
 *
 * The client sends names and gets availability back; which registry answered
 * is an implementation detail it never has to know.
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
  useStubRegistries,
} from "../helpers/testEnv";
import {StubRegistry} from "../helpers/stubRegistry";
import {
  cleanupTestData,
  snapshotCounters,
  type CounterSnapshot,
} from "../helpers/firestoreCleanup";
import {searchDomains} from "../../src/api/searchDomains";
import {
  healthDocId,
  resetHealthCache,
} from "../../src/bridge/registryHealth";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";
import {Timestamp} from "firebase-admin/firestore";

/** Shape `searchDomains` answers with. */
interface SearchResult {
  results: {name: string; registry: string; available: boolean}[];
  unsupported: string[];
  unavailable: string[];
}

describe("searchDomains", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;
  let uid: string;

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
    uid = await activeMemberUid();
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
    await cleanupTestData([uid], counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(async () => {
    sign.reset();
    nic.reset();
    resetTldCache();
    resetHealthCache();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqsign")).delete();
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId("kitaqnic")).delete();
  });

  /**
   * Marks one registry as already judged unreachable (circuit open), with a
   * fresh probe claim so the next command fails fast.
   *
   * @param {"kitaqsign" | "kitaqnic"} registry Registry to open.
   * @return {Promise<void>} Resolves once seeded.
   */
  async function openCircuit(
    registry: "kitaqsign" | "kitaqnic",
  ): Promise<void> {
    await db().collection(COLLECTIONS.counters)
      .doc(healthDocId(registry)).set({
        state: "unavailable",
        consecutive503: 9,
        firstFailureAt: Timestamp.fromMillis(Date.now() - 120_000),
        lastFailureAt: Timestamp.fromMillis(Date.now() - 1000),
        lastProbeAt: Timestamp.now(),
      });
  }

  it("allows an anonymous caller, since the search screen needs no login",
    async () => {
      // searchDomains.ts: deliberately public, like listTlds — it never
      // calls requireActiveUser (src/auth/callerGuard.ts), so this is not a
      // hole the guard rollout needs to close.
      const result = await callAs<SearchResult>(searchDomains,
        {names: ["a.com"]});
      assert.equal(result.results[0]?.name, "a.com");
    });

  it("rejects an empty list", async () => {
    const code = await expectHttpsError(
      callAs(searchDomains, {names: []}, uid),
    );
    assert.equal(code, "invalid-argument");
  });

  it("caps how many names one call may ask about", async () => {
    const names = Array.from({length: 26}, (_, i) => `bulk${i}.com`);
    const code = await expectHttpsError(
      callAs(searchDomains, {names}, uid),
    );
    assert.equal(code, "invalid-argument");
  });

  it("merges answers from both registries into one list", async () => {
    const result = await callAs<SearchResult>(searchDomains,
      {names: ["a.com", "b.shop"]}, uid);

    const byName = Object.fromEntries(
      result.results.map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["a.com"].registry, "kitaqsign");
    assert.equal(byName["b.shop"].registry, "kitaqnic");
    assert.equal(byName["a.com"].available, true);
  });

  it("sends one request per registry, not one per name", async () => {
    await callAs(searchDomains,
      {names: ["a.com", "b.net", "c.shop"]}, uid);

    assert.equal(sign.countCalls("POST", "/domains/check"), 1);
    assert.equal(nic.countCalls("POST", "/domains/check"), 1);
  });

  it("reports a taken name as unavailable", async () => {
    sign.seedDomain("used.com", "OTHER001");
    const result = await callAs<SearchResult>(searchDomains,
      {names: ["used.com"]}, uid);

    assert.equal(result.results[0].available, false);
  });

  it("lists names no registry can serve rather than failing", async () => {
    const result = await callAs<SearchResult>(searchDomains,
      {names: ["a.com", "b.zzz"]}, uid);

    assert.deepEqual(result.unsupported, ["b.zzz"]);
    assert.equal(result.results.length, 1);
  });

  it("normalises names before asking the registry", async () => {
    await callAs(searchDomains, {names: ["  MiXeD.CoM "]}, uid);
    const body = sign.calls.find((call) =>
      call.path === "/domains/check")?.body;
    assert.deepEqual(body?.names, ["mixed.com"]);
  });

  it("rejects a malformed name", async () => {
    const code = await expectHttpsError(
      callAs(searchDomains, {names: ["-bad-.com"]}, uid),
    );
    assert.equal(code, "invalid-argument");
  });

  // docs/仕様/registry-unavailable.md §5.1 — partial degradation, and the
  // two-phase claim: a fresh 503 is only "could not check", the stronger
  // "一時的に購入できません" needs the circuit-open judgement.
  it("keeps a fresh 503 as the honest unknown, not unavailable", async () => {
    // Route first, so the TLD map exists before the 503s start: during a
    // real outage the map survives in cache / mirror (§5.4).
    await callAs(searchDomains, {names: ["warm.com", "warm.shop"]}, uid);
    nic.force503 = true;

    const result = await callAs<SearchResult>(searchDomains,
      {names: ["a.com", "b.shop"]}, uid);

    assert.deepEqual(result.unavailable, [],
      "単発の503では接続不能と断定しない（60秒の判定窓が先）");
    assert.ok(!result.results.some((entry) => entry.name === "b.shop"),
      "答えのない名前は欠落し、クライアントが「？」に折る");
    const byName = Object.fromEntries(
      result.results.map((entry) => [entry.name, entry]),
    );
    assert.equal(byName["a.com"].available, true,
      "もう片方のレジストリの検索は巻き込まれない");
  });

  it("lists names of a judged-unreachable registry as unavailable",
    async () => {
      await callAs(searchDomains, {names: ["warm.com", "warm.shop"]}, uid);
      await openCircuit("kitaqnic");
      const checksBefore = nic.countCalls("POST", "/domains/check");

      const result = await callAs<SearchResult>(searchDomains,
        {names: ["a.com", "b.shop"]}, uid);

      assert.deepEqual(result.unavailable, ["b.shop"],
        "接続不能と判定済みのレジストリのTLDは unavailable として返す");
      assert.equal(nic.countCalls("POST", "/domains/check"), checksBefore,
        "判定済みのレジストリへは検索のたびに叩きにいかない");
      const byName = Object.fromEntries(
        result.results.map((entry) => [entry.name, entry]),
      );
      assert.equal(byName["a.com"].available, true);
    });

  it("answers with every name unavailable when both circuits are open",
    async () => {
      await callAs(searchDomains, {names: ["warm.com", "warm.shop"]}, uid);
      await openCircuit("kitaqsign");
      await openCircuit("kitaqnic");

      const result = await callAs<SearchResult>(searchDomains,
        {names: ["a.com", "b.shop"]}, uid);

      assert.deepEqual(result.results, []);
      assert.deepEqual([...result.unavailable].sort(), ["a.com", "b.shop"]);
    });
});
