/**
 * TLD routing (spec 4.3).
 *
 * The table is built from `session:hello`, never hard-coded, so these tests
 * change what the registries answer and assert that routing follows.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
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
import {
  getTldMap,
  groupByRegistry,
  resetTldCache,
  resolveRegistry,
  tldOf,
} from "../../src/bridge/registryRouter";
import {COLLECTIONS, db} from "../../src/config/firebase";

describe("tldOf", () => {
  it("takes the last label, lower-cased", () => {
    assert.equal(tldOf("Example.CO.JP"), "jp");
    assert.equal(tldOf("shop.example.com"), "com");
  });
});

describe("registryRouter", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net", ".org", ".info"]);
  const nic = new StubRegistry("KQNIC", [".shop", ".site", ".xyz"]);
  let counters: CounterSnapshot;

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
  });

  after(async () => {
    await cleanupTestData([], counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(() => {
    sign.reset();
    nic.reset();
    resetTldCache();
  });

  it("builds the map from what the registries report", async () => {
    const map = await getTldMap("APP-TEST-MAP");
    assert.equal(map["com"], "kitaqsign");
    assert.equal(map["info"], "kitaqsign");
    assert.equal(map["shop"], "kitaqnic");
    assert.equal(map["xyz"], "kitaqnic");
  });

  it("asks both registries exactly once per refresh", async () => {
    await getTldMap("APP-TEST-ONCE");
    assert.equal(sign.countCalls("GET", "/sessions/hello"), 1);
    assert.equal(nic.countCalls("GET", "/sessions/hello"), 1);
  });

  it("caches in process, so a second lookup issues no call", async () => {
    await getTldMap("APP-TEST-CACHE");
    await getTldMap("APP-TEST-CACHE");
    assert.equal(sign.countCalls("GET", "/sessions/hello"), 1);
  });

  it("reads Kitaqnic's list even under the other field name", async () => {
    nic.helloTldField = "supportedTlds";
    const map = await getTldMap("APP-TEST-ALTFIELD");
    assert.equal(map["shop"], "kitaqnic");
  });

  it("picks up a TLD the registry added, without a code change", async () => {
    nic.tlds.push(".tokyo");
    const map = await getTldMap("APP-TEST-NEWTLD");
    assert.equal(map["tokyo"], "kitaqnic");
    nic.tlds.pop();
  });

  it("routes a name to the registry that serves its TLD", async () => {
    assert.equal(await resolveRegistry("a.com", "APP-TEST-R1"), "kitaqsign");
    assert.equal(await resolveRegistry("b.shop", "APP-TEST-R2"), "kitaqnic");
  });

  it("returns nothing for a TLD neither registry serves", async () => {
    assert.equal(await resolveRegistry("c.zzz", "APP-TEST-R3"), undefined);
  });

  it("splits a mixed search into one request per registry", async () => {
    const {grouped, unsupported} = await groupByRegistry(
      ["a.com", "b.net", "c.shop", "d.zzz"],
      "APP-TEST-GROUP",
    );
    assert.deepEqual(grouped.get("kitaqsign"), ["a.com", "b.net"]);
    assert.deepEqual(grouped.get("kitaqnic"), ["c.shop"]);
    assert.deepEqual(unsupported, ["d.zzz"]);
  });

  it("mirrors the map so an outage does not break search", async () => {
    await getTldMap("APP-TEST-MIRROR");
    const mirrored = await db().collection(COLLECTIONS.counters)
      .doc("tldMap").get();
    assert.equal(mirrored.data()?.map?.com, "kitaqsign");

    resetTldCache();
    sign.helloFails = true;
    nic.helloFails = true;
    const map = await getTldMap("APP-TEST-AFTER-OUTAGE");
    assert.equal(map["com"], "kitaqsign", "ミラーから復元されること");
    assert.equal(map["shop"], "kitaqnic");
  });

  it("falls back to the measured static list when a registry is down and " +
    "there is nothing to inherit", async () => {
    // The poisoning scenario: fresh process, empty mirror (the emulator's
    // data was just reset), and one registry answering 503. The other
    // registry's live list must be joined by the static list for the dead
    // one — otherwise .com vanishes and the shrunken map gets mirrored.
    await db().collection(COLLECTIONS.counters).doc("tldMap").delete();
    resetTldCache();
    sign.helloFails = true;

    const map = await getTldMap("APP-TEST-STATIC-FALLBACK");

    assert.equal(map["com"], "kitaqsign",
      "hello が落ちても .com が消えないこと");
    assert.equal(map["shop"], "kitaqnic", "生きている側は実測値のまま");

    // And the mirror written from this run must contain the recovery, so
    // the shrinkage cannot stick.
    const mirrored = await db().collection(COLLECTIONS.counters)
      .doc("tldMap").get();
    assert.equal(mirrored.data()?.map?.com, "kitaqsign");
  });

  it("still routes the known TLDs when one registry is down", async () => {
    nic.helloFails = true;
    const map = await getTldMap("APP-TEST-PARTIAL");
    assert.equal(map["com"], "kitaqsign");
  });

  // docs/仕様/registry-unavailable.md §5.4: an outage must not make the
  // unreachable registry's TLDs vanish from the map — a partial hello
  // success must not overwrite the mirror with a shrunken map.
  it("keeps an unreachable registry's TLDs from the previous map",
    async () => {
      await getTldMap("APP-TEST-KEEP-WARM");
      resetTldCache();
      nic.force503 = true;

      const map = await getTldMap("APP-TEST-KEEP");

      assert.equal(map["com"], "kitaqsign");
      assert.equal(map["shop"], "kitaqnic",
        "503中のレジストリのTLDが前回マップから維持されること");

      const mirrored = await db().collection(COLLECTIONS.counters)
        .doc("tldMap").get();
      assert.equal(mirrored.data()?.map?.shop, "kitaqnic",
        "縮んだマップでミラーを上書きしないこと");
    });
});
