/**
 * Log retention: keeps the two append-only log collections from growing
 * without bound, without destroying what they exist for.
 *
 * The blanket rule the capacity concern asked for — "delete logs after an
 * hour" — would also delete the only rows anyone ever reads back:
 *
 *   - `registryLogs` failures are the investigation trail (spec 7.2). A
 *     member reports "paid but no domain" the next day; by then an
 *     hour-retention log has already destroyed the clTRID/svTRID evidence.
 *   - `pollMessages` rows marked unhandled/failed are kept precisely so a
 *     missed notification can be replayed once the cause is fixed.
 *
 * So retention is tiered instead: the bulk (successful command logs,
 * processed poll messages) lives for an hour; failures live for a day;
 * replayable messages are never touched here.
 *
 * Each collection is queried with the tier filter already applied — an
 * equality filter on `ok`/`handled` plus a range on the timestamp — instead
 * of over-fetching by timestamp alone and filtering in memory. The earlier
 * timestamp-only shape re-read every failed/unhandled row on every 5-minute
 * tick even though it never deleted them (~17k wasted reads/day in
 * production); scoping the query to only the rows that will actually be
 * deleted removes that cost. This does require composite indexes — see
 * `firestore.indexes.json` — which the Firestore emulator does not enforce,
 * so a query that is missing an index still passes locally and only fails
 * against the real service.
 *
 * Runs inside the poll worker's 5-minute tick rather than as its own
 * schedule: the third (and last) free Cloud Scheduler job stays reserved for
 * the expiry BATCH (spec 6.4), and sweeping "older than the cutoff" every
 * tick yields the same retention as an hourly job — just in smaller batches.
 */
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";

/** Everything else (successful commands, processed messages): one hour. */
export const BULK_RETENTION_MS = 60 * 60 * 1000;

/** Failed registry commands: a day, because they are read back late. */
export const FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on documents deleted per collection per run. A backlog left by
 * downtime drains over a few ticks instead of stretching one invocation.
 *
 * `registryLogs` now runs two queries (ok / failed) instead of one, so each
 * gets half the cap rather than the full 600: the combined worst case per
 * run stays the same as before this change, and neither tier can starve the
 * other when both have a large backlog.
 */
const MAX_DELETES_PER_RUN = 600;
const REGISTRY_LOGS_TIER_LIMIT = MAX_DELETES_PER_RUN / 2;

/** Firestore's own limit on writes per batch. */
const BATCH_LIMIT = 500;

/** What one retention sweep removed. */
export interface RetentionSummary {
  registryLogsDeleted: number;
  pollMessagesDeleted: number;
}

/**
 * Deletes the given documents in batches.
 *
 * @param {FirebaseFirestore.DocumentReference[]} refs Documents to delete.
 * @return {Promise<number>} How many deletes were committed.
 */
async function deleteAll(
  refs: FirebaseFirestore.DocumentReference[],
): Promise<number> {
  for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
    const batch = db().batch();
    for (const ref of refs.slice(start, start + BATCH_LIMIT)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

/**
 * Applies the retention policy once.
 *
 * Every query filters on the tier it targets before the timestamp range, so
 * the result set is exactly what will be deleted — no row is read just to be
 * kept. `writeRegistryLog` (bridge/registryLog.ts) always sets `ok` as a
 * plain boolean, and the poll worker (`domain/pollWorker.ts`) always sets
 * `handled` to one of "pending" | "done" | "failed" | "unhandled" before a
 * message becomes eligible here, so neither equality filter needs a
 * "field missing" fallback. Each `where` + range pair needs a composite
 * index — see `firestore.indexes.json`.
 *
 * @param {Date} now Injectable clock, for tests.
 * @return {Promise<RetentionSummary>} What was removed.
 */
export async function purgeAgedLogs(
  now: Date = new Date(),
): Promise<RetentionSummary> {
  const bulkCutoff = Timestamp.fromMillis(now.getTime() - BULK_RETENTION_MS);
  const failureCutoff = Timestamp.fromMillis(
    now.getTime() - FAILURE_RETENTION_MS,
  );

  // registryLogs: two disjoint tiers, queried separately so only rows that
  // will actually be deleted are ever read.
  const [okLogs, failedLogs] = await Promise.all([
    db()
      .collection(COLLECTIONS.registryLogs)
      .where("ok", "==", true)
      .where("requestedAt", "<", bulkCutoff)
      .limit(REGISTRY_LOGS_TIER_LIMIT)
      .get(),
    db()
      .collection(COLLECTIONS.registryLogs)
      .where("ok", "==", false)
      .where("requestedAt", "<", failureCutoff)
      .limit(REGISTRY_LOGS_TIER_LIMIT)
      .get(),
  ]);
  const logRefs = [...okLogs.docs, ...failedLogs.docs].map((doc) => doc.ref);

  // pollMessages: only rows whose processing finished cleanly. Unhandled and
  // failed rows are the replay queue and are deliberately never queried, let
  // alone swept.
  const agedMessages = await db()
    .collection(COLLECTIONS.pollMessages)
    .where("handled", "==", "done")
    .where("receivedAt", "<", bulkCutoff)
    .limit(MAX_DELETES_PER_RUN)
    .get();
  const messageRefs = agedMessages.docs.map((doc) => doc.ref);

  const summary: RetentionSummary = {
    registryLogsDeleted: await deleteAll(logRefs),
    pollMessagesDeleted: await deleteAll(messageRefs),
  };
  if (summary.registryLogsDeleted + summary.pollMessagesDeleted > 0) {
    logger.info("log retention sweep finished", {...summary});
  }
  return summary;
}
