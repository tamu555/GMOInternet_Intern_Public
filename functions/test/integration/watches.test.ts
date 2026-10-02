/**
 * 空き待ち通知 (domain/watches.ts + api/watchCallables.ts).
 *
 * The lifecycle under test, end to end:
 *
 *   registration (callable) → the sweep re-checks with `domain:check` →
 *   `available` the moment the registry confirms the name free → back to
 *   `watching` when somebody else takes it → `fulfilled` when the watcher
 *   took it themselves → `expired` when the TTL runs out. A registry inside
 *   an announced maintenance window is skipped whole, with zero HTTP.
 */
import {after, before, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import {Timestamp} from "firebase-admin/firestore";
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
import {resetHealthCache} from "../../src/bridge/registryHealth";
import {
  maintenanceDocId,
  resetMaintenanceCache,
} from "../../src/bridge/registryMaintenance";
import {resetTldCache} from "../../src/bridge/registryRouter";
import {
  MAX_ACTIVE_WATCHES,
  SWEEP_THROTTLE_DOC,
  runWatchSweep,
  watchDocId,
  type WatchSummary,
} from "../../src/domain/watches";
import {
  addWatch,
  cancelWatch,
  listWatches,
} from "../../src/api/watchCallables";
import {COLLECTIONS, db} from "../../src/config/firebase";

/** Shape `addWatch` answers with. */
interface AddWatchAnswer {
  watch: WatchSummary;
  alreadyWatching: boolean;
}

/** Shape `listWatches` answers with. */
interface ListWatchesAnswer {
  watches: WatchSummary[];
}

/**
 * Reads one stored watch document.
 *
 * @param {string} uid Member holding the watch.
 * @param {string} name Watched domain name.
 * @return {Promise<FirebaseFirestore.DocumentData | undefined>} Raw data.
 */
async function storedWatch(uid: string, name: string) {
  const doc = await db().collection(COLLECTIONS.watches)
    .doc(watchDocId(uid, name)).get();
  return doc.data();
}

describe("watches", {skip: HAS_EMULATOR ? false : SKIP_REASON}, () => {
  const sign = new StubRegistry("KQSGN", [".com", ".net"]);
  const nic = new StubRegistry("KQNIC", [".shop"]);
  let counters: CounterSnapshot;
  const uids: string[] = [];

  before(async () => {
    await requireEmulator();
    useStubRegistries(await sign.start(), await nic.start());
    counters = await snapshotCounters();
  });

  /** Removes the shared state docs this suite touches. */
  async function deleteStateDocs(): Promise<void> {
    await db().collection(COLLECTIONS.counters)
      .doc(SWEEP_THROTTLE_DOC).delete();
    for (const registry of ["kitaqsign", "kitaqnic"] as const) {
      await db().collection(COLLECTIONS.counters)
        .doc(maintenanceDocId(registry)).delete();
    }
  }

  after(async () => {
    await deleteStateDocs();
    await cleanupTestData(uids, counters);
    await sign.stop();
    await nic.stop();
  });

  beforeEach(async () => {
    sign.reset();
    nic.reset();
    resetHealthCache();
    resetMaintenanceCache();
    resetTldCache();
    await deleteStateDocs();
    // The sweep queries the whole collection, so ANY live watch — an earlier
    // case's, or one a dev session left on the shared emulator — would leak
    // into this one's tallies. Clearing the collection wholesale follows the
    // registryMaintenance suite's precedent with pollMessages.
    const stored = await db().collection(COLLECTIONS.watches).get();
    await Promise.all(stored.docs.map((doc) => doc.ref.delete()));
  });

  /**
   * A fresh active member, remembered for cleanup.
   *
   * @return {Promise<string>} The member's uid.
   */
  async function member(): Promise<string> {
    const uid = await activeMemberUid();
    uids.push(uid);
    return uid;
  }

  it("registers a watch, and a repeat lands on the same document",
    async () => {
      const uid = await member();

      const first = await callAs<AddWatchAnswer>(
        addWatch, {domainName: "wanted.com"}, uid);
      assert.equal(first.alreadyWatching, false);
      assert.equal(first.watch.state, "watching");
      assert.equal(first.watch.registry, "kitaqsign");

      const again = await callAs<AddWatchAnswer>(
        addWatch, {domainName: "wanted.com"}, uid);
      assert.equal(again.alreadyWatching, true);

      const mine = await db().collection(COLLECTIONS.watches)
        .where("uid", "==", uid).get();
      assert.equal(mine.size, 1);
    });

  it("rejects an unsupported TLD", async () => {
    const uid = await member();
    const code = await expectHttpsError(
      callAs(addWatch, {domainName: "wanted.example"}, uid));
    assert.equal(code, "invalid-argument");
  });

  it("caps active watches per member", async () => {
    const uid = await member();
    for (let i = 0; i < MAX_ACTIVE_WATCHES; i++) {
      await callAs(addWatch, {domainName: `wanted-${i}.com`}, uid);
    }
    const code = await expectHttpsError(
      callAs(addWatch, {domainName: "one-too-many.com"}, uid));
    assert.equal(code, "failed-precondition");
  });

  it("walks watching → available → watching as the name frees and is " +
    "taken again", async () => {
    const uid = await member();
    sign.seedDomain("busy.com", "OTHER-REG");
    await callAs(addWatch, {domainName: "busy.com"}, uid);

    // Still taken: the watch stays armed, but the check is recorded.
    let sweep = await runWatchSweep({force: true});
    assert.equal(sweep.checked, 1);
    assert.equal(sweep.becameAvailable, 0);
    let stored = await storedWatch(uid, "busy.com");
    assert.equal(stored?.state, "watching");
    assert.notEqual(stored?.lastCheckedAt, null);

    // The registry purges the name → the very next sweep notices.
    sign.expireGracePeriod("busy.com");
    sweep = await runWatchSweep({force: true});
    assert.equal(sweep.becameAvailable, 1);
    stored = await storedWatch(uid, "busy.com");
    assert.equal(stored?.state, "available");
    assert.notEqual(stored?.availableAt, null);

    // Somebody else moves first → the notice comes down, the watch re-arms.
    sign.seedDomain("busy.com", "OTHER-REG");
    sweep = await runWatchSweep({force: true});
    assert.equal(sweep.becameAvailable, 0);
    stored = await storedWatch(uid, "busy.com");
    assert.equal(stored?.state, "watching");
    assert.equal(stored?.availableAt, null);
  });

  it("marks the watch fulfilled when the watcher took the name themselves",
    async () => {
      const uid = await member();
      await callAs(addWatch, {domainName: "gotit.com"}, uid);

      // The member bought the name through the ordinary order flow: the
      // registry holds it and our mirror names the member as its owner.
      sign.seedDomain("gotit.com", "U000001");
      await db().collection(COLLECTIONS.domains)
        .doc(`${uid}__gotit.com`)
        .set({uid, name: "gotit.com", registry: "kitaqsign"});

      const sweep = await runWatchSweep({force: true});
      assert.equal(sweep.fulfilled, 1);
      const stored = await storedWatch(uid, "gotit.com");
      assert.equal(stored?.state, "fulfilled");
    });

  it("skips a registry inside an announced maintenance window, with zero " +
    "HTTP, while the other registry is still swept", async () => {
    const uid = await member();
    await callAs(addWatch, {domainName: "waiting.com"}, uid);
    await callAs(addWatch, {domainName: "waiting.shop"}, uid);

    await db().collection(COLLECTIONS.counters)
      .doc(maintenanceDocId("kitaqsign")).set({
        active: true,
        windowStart: Timestamp.fromMillis(Date.now() - 60_000),
        windowEnd: Timestamp.fromMillis(Date.now() + 60 * 60_000),
        msgId: "1",
        msgType: "registry:maintenance",
        note: null,
        rawPayload: null,
        announcedAt: Timestamp.now(),
        lastProbeAt: null,
        clearedAt: null,
        clearedBy: null,
      });

    const checksBefore = sign.countCalls("POST", "/domains/check");
    const sweep = await runWatchSweep({force: true});

    assert.deepEqual(sweep.skipped,
      [{registry: "kitaqsign", reason: "maintenance"}]);
    assert.equal(sign.countCalls("POST", "/domains/check"), checksBefore);
    // The other registry answered: waiting.shop is free → available.
    assert.equal(sweep.becameAvailable, 1);
    const signWatch = await storedWatch(uid, "waiting.com");
    assert.equal(signWatch?.state, "watching");
    assert.equal(signWatch?.lastCheckedAt, null);
    const nicWatch = await storedWatch(uid, "waiting.shop");
    assert.equal(nicWatch?.state, "available");
  });

  it("expires a watch past its TTL without asking the registry about it",
    async () => {
      const uid = await member();
      await callAs(addWatch, {domainName: "forgotten.com"}, uid);
      await db().collection(COLLECTIONS.watches)
        .doc(watchDocId(uid, "forgotten.com"))
        .set({expiresAt: Timestamp.fromMillis(Date.now() - 1000)},
          {merge: true});

      const sweep = await runWatchSweep({force: true});
      assert.equal(sweep.expired, 1);
      assert.equal(sweep.checked, 0);
      assert.equal(sign.countCalls("POST", "/domains/check"), 0);
      const stored = await storedWatch(uid, "forgotten.com");
      assert.equal(stored?.state, "expired");
    });

  it("throttles back-to-back unforced sweeps", async () => {
    const first = await runWatchSweep();
    assert.equal(first.throttled, false);
    const second = await runWatchSweep();
    assert.equal(second.throttled, true);
    // The scheduled worker's forced sweep still runs.
    const forced = await runWatchSweep({force: true});
    assert.equal(forced.throttled, false);
  });

  it("cancels a watch and omits it from the list", async () => {
    const uid = await member();
    await callAs(addWatch, {domainName: "changed-mind.com"}, uid);

    await callAs(cancelWatch, {domainName: "changed-mind.com"}, uid);
    const stored = await storedWatch(uid, "changed-mind.com");
    assert.equal(stored?.state, "cancelled");

    const listed = await callAs<ListWatchesAnswer>(listWatches, {}, uid);
    assert.equal(listed.watches.length, 0);

    const code = await expectHttpsError(
      callAs(cancelWatch, {domainName: "never-watched.com"}, uid));
    assert.equal(code, "not-found");
  });

  it("re-arms a finished watch in place instead of refusing it", async () => {
    const uid = await member();
    await callAs(addWatch, {domainName: "round-two.com"}, uid);
    await callAs(cancelWatch, {domainName: "round-two.com"}, uid);

    const again = await callAs<AddWatchAnswer>(
      addWatch, {domainName: "round-two.com"}, uid);
    assert.equal(again.alreadyWatching, false);
    assert.equal(again.watch.state, "watching");
  });
});
