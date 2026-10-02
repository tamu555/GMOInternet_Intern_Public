/**
 * 空き待ち通知 (domain watch) — "空いたらお知らせ".
 *
 * A member who wants a name that cannot be bought right now — someone else
 * holds it, or its registry is in an announced maintenance window / judged
 * unreachable — registers a watch instead of paying for an uncertain
 * outcome. A background sweep re-checks availability with `domain:check`
 * and flips the watch to `available` the moment the registry confirms the
 * name is free; マイページ then shows the notice and links straight into the
 * normal purchase flow.
 *
 * Deliberately NOT a backorder: nothing is charged and nothing is reserved.
 * The pseudo-payment only ever settles on a confirmed availability (the
 * ordinary order flow), so "空きが分からないのに決済" never happens. Several
 * members may watch the same name; when it frees up they are all told, and
 * from there it is first come first served — which is why every notice
 * carries the "空き状況は変動する" wording.
 *
 * The document id is `${uid}__${domainName}`, the same discipline as orders:
 * a double-submitted button lands on the same document instead of minting a
 * duplicate watch. It also means one member watches one name at most once —
 * it does NOT mean a name has only one watcher (different uids, different
 * documents).
 *
 * State machine (terminal states: fulfilled / expired / cancelled):
 *
 *   watching ──(check: free)──▶ available ──(check: taken again)──▶ watching
 *      │                            │
 *      │                            └─(taken by THIS member)──▶ fulfilled
 *      ├─(taken by THIS member)──▶ fulfilled
 *      ├─(expiresAt passes)──▶ expired          (watching/available alike)
 *      └─(member cancels)──▶ cancelled          (watching/available alike)
 */
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {isRegistryError} from "../bridge/errors";
import {getRegistryClient} from "../bridge/registryRouter";
import {adhocClTrid} from "./clTrid";
import {getOwnedDomain} from "./domainRepository";

/** States a watch can be in. */
export type WatchState =
  | "watching"
  | "available"
  | "fulfilled"
  | "expired"
  | "cancelled";

/**
 * Watches one member may hold at once (`watching` + `available`). A cap, so
 * the sweep can never be turned into a bulk availability scanner.
 */
export const MAX_ACTIVE_WATCHES = 10;

/** How long a watch keeps being checked before it expires on its own. */
export const WATCH_TTL_DAYS = 30;

/**
 * Floor between two sweeps. The manual drain path (`drainPollQueue`) runs on
 * every マイページ load, which polls every 30 seconds — without a floor each
 * open tab would multiply the registry traffic. The 5-minute scheduled
 * worker passes `force` and is never throttled.
 */
export const SWEEP_MIN_INTERVAL_MS = 60_000;

/** Names per `domain:check`, matching the search screen's request cap. */
const CHECK_CHUNK = 25;

/** Stored shape of one watch. */
interface WatchDoc {
  uid: string;
  domainName: string;
  registry: RegistryId;
  state: WatchState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  lastCheckedAt: Timestamp | null;
  /** When the sweep last confirmed the name free; null while `watching`. */
  availableAt: Timestamp | null;
}

/** Client-safe view of one watch. */
export interface WatchSummary {
  domainName: string;
  registry: RegistryId;
  state: WatchState;
  createdAt: string;
  expiresAt: string;
  availableAt: string | null;
}

/** What `addWatch` did. */
export type AddWatchOutcome =
  /** A fresh watch (or a re-arm of a finished one) was written. */
  | {outcome: "added"; watch: WatchSummary}
  /** The member already watches this name; nothing was written. */
  | {outcome: "already"; watch: WatchSummary}
  /** The member is at MAX_ACTIVE_WATCHES; nothing was written. */
  | {outcome: "limit"; activeCount: number};

/** What one sweep run did. */
export interface WatchSweepResult {
  /** True when the run was skipped because one just ran (see the floor). */
  throttled: boolean;
  /** Watches whose availability was actually checked. */
  checked: number;
  becameAvailable: number;
  expired: number;
  fulfilled: number;
  /** Registries whose check was skipped, and why. */
  skipped: {registry: RegistryId; reason: string}[];
}

/**
 * Document id of one member's watch on one name. Exported for tests.
 *
 * @param {string} uid Member holding the watch.
 * @param {string} domainName Watched name, already normalised.
 * @return {string} Firestore document id.
 */
export function watchDocId(uid: string, domainName: string): string {
  return `${uid}__${domainName}`;
}

/** @return {FirebaseFirestore.CollectionReference} The watches collection. */
function watchesCollection() {
  return db().collection(COLLECTIONS.watches);
}

/**
 * Whether a stored watch still counts against the member's cap and is still
 * worth checking. Expiry is judged at read time, so a watch that ran out
 * between sweeps reads as inactive without waiting for the next write.
 *
 * @param {WatchDoc} doc Stored watch.
 * @param {number} nowMs Current time.
 * @return {boolean} True while watching/available and not past expiry.
 */
function isActive(doc: WatchDoc, nowMs: number): boolean {
  return (
    (doc.state === "watching" || doc.state === "available") &&
    doc.expiresAt.toMillis() > nowMs
  );
}

/**
 * The state to present to a client, with read-time expiry applied.
 *
 * @param {WatchDoc} doc Stored watch.
 * @param {number} nowMs Current time.
 * @return {WatchState} Stored state, or `expired` when the TTL has passed.
 */
function presentedState(doc: WatchDoc, nowMs: number): WatchState {
  if (
    (doc.state === "watching" || doc.state === "available") &&
    doc.expiresAt.toMillis() <= nowMs
  ) {
    return "expired";
  }
  return doc.state;
}

/**
 * Folds a stored watch into the client-safe shape.
 *
 * @param {WatchDoc} doc Stored watch.
 * @param {number} nowMs Current time, for read-time expiry.
 * @return {WatchSummary} Client view.
 */
function toSummary(doc: WatchDoc, nowMs: number): WatchSummary {
  return {
    domainName: doc.domainName,
    registry: doc.registry,
    state: presentedState(doc, nowMs),
    createdAt: doc.createdAt.toDate().toISOString(),
    expiresAt: doc.expiresAt.toDate().toISOString(),
    availableAt: doc.availableAt?.toDate().toISOString() ?? null,
  };
}

/**
 * Registers (or re-arms) a watch on one name for one member.
 *
 * Adding a name the member already actively watches is answered with the
 * existing watch rather than an error — the double-submit case. A finished
 * watch (expired / cancelled / fulfilled) is re-armed in place: same
 * document, fresh TTL.
 *
 * @param {string} uid Member registering the watch.
 * @param {string} domainName Watched name, already normalised.
 * @param {RegistryId} registry Registry serving the name's TLD.
 * @return {Promise<AddWatchOutcome>} What happened.
 */
export async function addWatch(
  uid: string,
  domainName: string,
  registry: RegistryId,
): Promise<AddWatchOutcome> {
  const nowMs = Date.now();
  const ref = watchesCollection().doc(watchDocId(uid, domainName));

  const existing = (await ref.get()).data() as WatchDoc | undefined;
  if (existing && isActive(existing, nowMs)) {
    return {outcome: "already", watch: toSummary(existing, nowMs)};
  }

  // The cap counts live watches only, so expired ones free their slot
  // without waiting for a sweep to mark them. The uid filter alone keeps the
  // query on the automatic single-field index (a state filter here would
  // demand a composite index for no gain — a member holds few documents).
  const mine = await watchesCollection().where("uid", "==", uid).get();
  const activeCount = mine.docs.filter((doc) =>
    isActive(doc.data() as WatchDoc, nowMs) &&
    doc.id !== ref.id,
  ).length;
  if (activeCount >= MAX_ACTIVE_WATCHES) {
    return {outcome: "limit", activeCount};
  }

  const now = Timestamp.fromMillis(nowMs);
  const doc: WatchDoc = {
    uid,
    domainName,
    registry,
    state: "watching",
    createdAt: now,
    updatedAt: now,
    expiresAt: Timestamp.fromMillis(
      nowMs + WATCH_TTL_DAYS * 24 * 60 * 60 * 1000,
    ),
    lastCheckedAt: null,
    availableAt: null,
  };
  await ref.set(doc);
  return {outcome: "added", watch: toSummary(doc, nowMs)};
}

/**
 * Every watch of one member, newest first, cancelled ones omitted.
 *
 * @param {string} uid Member whose watches to list.
 * @return {Promise<WatchSummary[]>} Client-safe views.
 */
export async function listWatches(uid: string): Promise<WatchSummary[]> {
  const nowMs = Date.now();
  const mine = await watchesCollection().where("uid", "==", uid).get();
  return mine.docs
    .map((doc) => doc.data() as WatchDoc)
    .filter((doc) => doc.state !== "cancelled")
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    .map((doc) => toSummary(doc, nowMs));
}

/**
 * Cancels one member's watch on one name.
 *
 * @param {string} uid Member cancelling.
 * @param {string} domainName Watched name, already normalised.
 * @return {Promise<boolean>} False when the member holds no such watch.
 */
export async function cancelWatch(
  uid: string,
  domainName: string,
): Promise<boolean> {
  const ref = watchesCollection().doc(watchDocId(uid, domainName));
  const existing = (await ref.get()).data() as WatchDoc | undefined;
  if (!existing || existing.uid !== uid) return false;
  await ref.set(
    {state: "cancelled", updatedAt: Timestamp.now()},
    {merge: true},
  );
  return true;
}

/** Firestore doc under `counters` holding the sweep's throttle stamp. */
export const SWEEP_THROTTLE_DOC = "watchSweep";

/**
 * Claims the sweep slot, or reports that one ran too recently.
 *
 * Best effort: a read-then-write race lets two concurrent sweeps through,
 * which costs a duplicate `domain:check` and nothing else.
 *
 * @param {number} nowMs Current time.
 * @return {Promise<boolean>} True when this run may proceed.
 */
async function claimSweepSlot(nowMs: number): Promise<boolean> {
  const ref = db()
    .collection(COLLECTIONS.counters)
    .doc(SWEEP_THROTTLE_DOC);
  try {
    const data = (await ref.get()).data() as
      {lastRunAt?: Timestamp} | undefined;
    const lastMs = data?.lastRunAt?.toMillis() ?? 0;
    if (nowMs - lastMs < SWEEP_MIN_INTERVAL_MS) return false;
    await ref.set({lastRunAt: Timestamp.fromMillis(nowMs)}, {merge: true});
    return true;
  } catch (error) {
    // The throttle exists to save traffic, not to gate correctness: when it
    // cannot be read the sweep still runs.
    logger.warn("watch sweep: throttle unreadable, running anyway", {
      error: String(error),
    });
    return true;
  }
}

/**
 * Splits an array into runs of at most `size`.
 *
 * @param {Array<T>} items Items to split.
 * @param {number} size Maximum run length.
 * @return {Array<Array<T>>} The runs, in order.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    runs.push(items.slice(i, i + size));
  }
  return runs;
}

/**
 * Availability of every distinct watched name at one registry.
 *
 * @param {RegistryId} registry Registry to ask.
 * @param {string[]} names Distinct names watched there.
 * @return {Promise<Map<string, boolean>>} name (lowercased) → available.
 * @throws {RegistryError} When the check could not run (maintenance window,
 *   open circuit, transport failure) — the caller skips the registry.
 */
async function checkNamesAt(
  registry: RegistryId,
  names: string[],
): Promise<Map<string, boolean>> {
  const availability = new Map<string, boolean>();
  const client = getRegistryClient(registry);
  for (const [index, run] of chunk(names, CHECK_CHUNK).entries()) {
    const answers = await client.checkDomains(
      run,
      adhocClTrid("WATCH", `${registry}-${index}`),
    );
    for (const answer of answers) {
      availability.set(answer.name.toLowerCase(), answer.available);
    }
  }
  return availability;
}

/**
 * One watch's transition, given what the check said.
 *
 * @param {FirebaseFirestore.DocumentReference} ref The watch document.
 * @param {WatchDoc} doc Its stored state.
 * @param {boolean | undefined} available What the registry answered for the
 *   name, or undefined when its answer omitted it.
 * @param {Timestamp} now Sweep timestamp.
 * @param {WatchSweepResult} result Tallies to update.
 * @return {Promise<void>} Resolves once any write landed.
 */
async function applyCheckAnswer(
  ref: FirebaseFirestore.DocumentReference,
  doc: WatchDoc,
  available: boolean | undefined,
  now: Timestamp,
  result: WatchSweepResult,
): Promise<void> {
  if (available === undefined) return;
  result.checked++;

  if (available) {
    if (doc.state !== "available") {
      result.becameAvailable++;
      await ref.set(
        {state: "available", availableAt: now, lastCheckedAt: now,
          updatedAt: now},
        {merge: true},
      );
      return;
    }
    await ref.set({lastCheckedAt: now, updatedAt: now}, {merge: true});
    return;
  }

  // Taken — possibly by the watcher, who then deserves "取得済み" rather
  // than a silent re-arm. The mirror read is one cheap document.
  const owned = await getOwnedDomain(doc.uid, doc.domainName)
    .catch(() => null);
  if (owned) {
    result.fulfilled++;
    await ref.set(
      {state: "fulfilled", lastCheckedAt: now, updatedAt: now},
      {merge: true},
    );
    return;
  }

  if (doc.state === "available") {
    // Somebody else moved first. The notice comes down and the watch
    // re-arms — the member keeps being told the next time it frees up.
    await ref.set(
      {state: "watching", availableAt: null, lastCheckedAt: now,
        updatedAt: now},
      {merge: true},
    );
    return;
  }
  await ref.set({lastCheckedAt: now, updatedAt: now}, {merge: true});
}

/**
 * Re-checks every live watch against its registry.
 *
 * Runs from the 5-minute scheduled worker (with `force`) and, throttled,
 * from the manual `drainPollQueue` path the emulator relies on. A registry
 * inside an announced maintenance window, or judged unreachable, is skipped
 * whole: the EppClient gate fails the first check fast without touching the
 * network, and the sweep simply tries again next round — the sweep must
 * never be the thing that hammers a down registry.
 *
 * @param {object} options `force` bypasses the interval floor.
 * @return {Promise<WatchSweepResult>} What the run did.
 */
export async function runWatchSweep(
  options: {force?: boolean} = {},
): Promise<WatchSweepResult> {
  const result: WatchSweepResult = {
    throttled: false,
    checked: 0,
    becameAvailable: 0,
    expired: 0,
    fulfilled: 0,
    skipped: [],
  };

  const nowMs = Date.now();
  if (!options.force && !(await claimSweepSlot(nowMs))) {
    result.throttled = true;
    return result;
  }
  const now = Timestamp.fromMillis(nowMs);

  const live = await watchesCollection()
    .where("state", "in", ["watching", "available"])
    .get();

  const byRegistry = new Map<
    RegistryId,
    {ref: FirebaseFirestore.DocumentReference; doc: WatchDoc}[]
  >();
  for (const snapshot of live.docs) {
    const doc = snapshot.data() as WatchDoc;
    if (doc.expiresAt.toMillis() <= nowMs) {
      result.expired++;
      await snapshot.ref.set(
        {state: "expired", updatedAt: now},
        {merge: true},
      );
      continue;
    }
    const group = byRegistry.get(doc.registry) ?? [];
    group.push({ref: snapshot.ref, doc});
    byRegistry.set(doc.registry, group);
  }

  // Registries are swept independently: one being down must not stop the
  // other's watches from being checked (partial degradation, exactly like
  // searchDomains).
  await Promise.all(
    [...byRegistry.entries()].map(async ([registry, watches]) => {
      const names = [...new Set(watches.map((entry) => entry.doc.domainName))];
      let availability: Map<string, boolean>;
      try {
        availability = await checkNamesAt(registry, names);
      } catch (error) {
        const reason = isRegistryError(error) ?
          (error.maintenance ? "maintenance" :
            error.circuitOpen ? "unavailable" : "error") :
          "error";
        result.skipped.push({registry, reason});
        logger.info("watch sweep: registry skipped", {
          registry,
          reason,
          error: isRegistryError(error) ?
            error.message : String(error),
        });
        return;
      }
      for (const {ref, doc} of watches) {
        await applyCheckAnswer(
          ref,
          doc,
          availability.get(doc.domainName.toLowerCase()),
          now,
          result,
        );
      }
    }),
  );

  if (result.becameAvailable > 0 || result.fulfilled > 0 ||
      result.expired > 0 || result.skipped.length > 0) {
    logger.info("watch sweep finished", {...result});
  }
  return result;
}
