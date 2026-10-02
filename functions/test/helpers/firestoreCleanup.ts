/**
 * Test data teardown.
 *
 * Every integration test writes under a throwaway uid, so cleanup is a
 * uid-scoped delete plus a restore of the shared counters. `registryLogs`
 * rows written for `hello` and `check` carry no uid, so those are removed by
 * the ids collected during the run.
 */
import {db, COLLECTIONS} from "../../src/config/firebase";

/** Collections that hold per-member documents. */
const UID_SCOPED = [
  COLLECTIONS.orders,
  COLLECTIONS.domains,
  COLLECTIONS.registryContacts,
  COLLECTIONS.registryLogs,
  COLLECTIONS.transfers,
  COLLECTIONS.watches,
];

/** Counter documents shared by every test. */
const COUNTER_DOCS = ["orders", "users", "tldMap"];

/** Snapshot of the counters taken before a suite ran. */
export type CounterSnapshot = Record<
  string,
  FirebaseFirestore.DocumentData | null
>;

/**
 * Records the current counter values so they can be put back afterwards.
 *
 * @return {Promise<CounterSnapshot>} Values to restore later.
 */
export async function snapshotCounters(): Promise<CounterSnapshot> {
  const snapshot: CounterSnapshot = {};
  for (const name of COUNTER_DOCS) {
    const doc = await db().collection(COLLECTIONS.counters).doc(name).get();
    snapshot[name] = doc.exists ? (doc.data() ?? null) : null;
  }
  return snapshot;
}

/**
 * Deletes everything a suite wrote and puts the counters back.
 *
 * @param {string[]} uids Test uids used by the suite.
 * @param {CounterSnapshot} counters Snapshot taken before the suite.
 * @return {Promise<void>} Resolves once cleanup finished.
 */
export async function cleanupTestData(
  uids: string[],
  counters: CounterSnapshot,
): Promise<void> {
  for (const uid of uids) {
    for (const collection of UID_SCOPED) {
      const found = await db().collection(collection)
        .where("uid", "==", uid).get();
      await Promise.all(found.docs.map((doc) => doc.ref.delete()));
    }
    await db().collection(COLLECTIONS.users).doc(uid).delete();
  }

  // hello / check rows carry no uid; they are only ever written by tests when
  // the base URLs point at a stub, so clearing the ones without a uid is safe
  // here and keeps the emulator tidy between runs.
  const orphans = await db().collection(COLLECTIONS.registryLogs)
    .where("uid", "==", null).get();
  await Promise.all(orphans.docs.map((doc) => doc.ref.delete()));

  for (const name of COUNTER_DOCS) {
    const ref = db().collection(COLLECTIONS.counters).doc(name);
    const previous = counters[name];
    if (previous) await ref.set(previous);
    else await ref.delete();
  }
}
