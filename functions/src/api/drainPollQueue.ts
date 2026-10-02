/**
 * `drainPollQueue` — runs the poll worker on demand.
 *
 * Scheduled functions do not fire in the emulator, and a five-minute wait is
 * not something to do in front of an audience, so the same work is reachable
 * as a Callable for local development and for the demo.
 *
 * Members can call this (TransferInSection relies on it to surface transfer
 * notifications without waiting for the scheduler), but on a deployed project
 * every call goes through the global throttle below: `{force: true}` is
 * honoured only in the emulator, so a member can at most trigger the same
 * drain the scheduled worker runs, once per window, for everyone.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS, REGISTRY_IDS} from "../config/options";
import type {RegistryId} from "../config/options";
import {
  drainAllQueues,
  drainRegistryQueue,
} from "../domain/pollWorker";
import {
  registerMaintenancePollHandlers,
} from "../domain/maintenanceNotifications";
import {registerTransferPollHandlers} from "../domain/transferNotifications";
import {reconcilePendingTransfers} from "../domain/transferReconciler";
import {isEmulator} from "../dev/force503Flag";
import {runWatchSweep} from "../domain/watches";
import {toHttpsError} from "./httpsErrors";

// The manual drain has to process notifications exactly like the scheduled
// one does, so the handlers are registered here too (spec 6.6).
registerTransferPollHandlers();
registerMaintenancePollHandlers();

/**
 * Global throttle across every caller. One drain runs the full poll +
 * reconcile pipeline (registry roundtrips, transfer/mirror queries, EPP
 * probes, one registryLogs write per command), so N open tabs polling it
 * would multiply Firestore traffic N-fold for identical work. One shared
 * Firestore-transaction read replaces all of that inside the window.
 * `{force: true}` bypasses it — for scripts/poll-loop.sh's `--once` catch-up
 * and E2E runs, where a deliberate drain must never silently no-op. Honoured
 * only in the emulator; a deployed function always applies the throttle.
 */
const THROTTLE_DOC = "drainPollQueueThrottle";
const THROTTLE_MS = 60_000;

/**
 * Claims the next drain slot, first caller in the window wins.
 *
 * @return {Promise<boolean>} False when a drain ran within THROTTLE_MS.
 */
async function claimDrainSlot(): Promise<boolean> {
  const ref = db().collection(COLLECTIONS.counters).doc(THROTTLE_DOC);
  try {
    return await db().runTransaction(async (tx) => {
      const last = (await tx.get(ref)).data()?.lastDrainAt as
        Timestamp | undefined;
      if (last && Date.now() - last.toMillis() < THROTTLE_MS) return false;
      tx.set(ref, {lastDrainAt: Timestamp.now()}, {merge: true});
      return true;
    });
  } catch (error) {
    // The throttle is a cost guard, not a correctness gate: when it cannot
    // be read the drain proceeds.
    logger.warn("drainPollQueue: throttle check failed, draining anyway",
      {error: String(error)});
    return true;
  }
}

/**
 * The watch sweep, throttled and unable to fail the drain.
 *
 * The drain itself is already behind claimDrainSlot's 60-second window (and
 * the frontend only triggers it against the emulator), but the sweep keeps
 * its own interval floor too — SWEEP_MIN_INTERVAL_MS in domain/watches.ts —
 * so registry traffic stays bounded even on forced drains.
 *
 * @return {Promise<object | null>} Sweep result, or null when it failed.
 */
async function sweepWatchesBestEffort() {
  try {
    return await runWatchSweep();
  } catch {
    return null;
  }
}

/** Runs one poll pass over one registry, or over both. */
export const drainPollQueue = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 300},
  async (request) => {
    await requireActiveUser(request.auth);
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    try {
      const force = isEmulator() && (request.data ?? {}).force === true;
      if (!force && !(await claimDrainSlot())) {
        return {throttled: true, results: [], reconcile: null};
      }
      const asked = (request.data ?? {}).registry as string | undefined;
      if (asked !== undefined) {
        if (!REGISTRY_IDS.includes(asked as RegistryId)) {
          throw new HttpsError(
            "invalid-argument",
            `registry は ${REGISTRY_IDS.join(" / ")} のいずれかです。`,
          );
        }
        const one = await drainRegistryQueue(asked as RegistryId);
        return {
          results: [one],
          reconcile: await reconcilePendingTransfers(),
          watchSweep: await sweepWatchesBestEffort(),
        };
      }
      const results = await drainAllQueues();
      return {
        results,
        reconcile: await reconcilePendingTransfers(),
        watchSweep: await sweepWatchesBestEffort(),
      };
    } catch (error) {
      throw toHttpsError(error, "drainPollQueue");
    }
  },
);
