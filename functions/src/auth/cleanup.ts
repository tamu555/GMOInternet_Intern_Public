import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";

import {db} from "../config/firebase.js";
import {
  ABANDONED_SIGNUP_CLEANUP_DAYS,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_SECOND,
  PURGING_RETRY_DELAY_SECONDS,
  USER_STATUS,
} from "./constants.js";
import {userDocument, usersCollection} from "./firestore.js";
import {
  deleteAuthUserIfPresent,
  purgePendingAccount,
} from "./account-lifecycle.js";
import type {UserDocument} from "./types.js";

const DAILY_CLEANUP_SCHEDULE = "0 0 * * *";
const CLEANUP_TIME_ZONE = "Asia/Tokyo";

interface CleanupResult {
  completed: number;
  failures: number;
}

export const cleanupAbandonedGoogleSignups = onSchedule(
  {
    schedule: DAILY_CLEANUP_SCHEDULE,
    timeZone: CLEANUP_TIME_ZONE,
  },
  async (): Promise<void> => {
    const now = Timestamp.now();
    const abandonedCutoff = Timestamp.fromMillis(
      now.toMillis() -
        ABANDONED_SIGNUP_CLEANUP_DAYS * MILLISECONDS_PER_DAY,
    );
    // Provisional one-hour retry threshold from auth.md sections 4.9 and 8.
    const purgingCutoff = Timestamp.fromMillis(
      now.toMillis() -
        PURGING_RETRY_DELAY_SECONDS * MILLISECONDS_PER_SECOND,
    );

    const abandoned = await cleanupAbandonedSignups(abandonedCutoff);
    const overdue = await purgeOverdueAccounts(now);
    const stuck = await retryStuckPurges(purgingCutoff);
    const failures =
      abandoned.failures + overdue.failures + stuck.failures;
    const summary = {
      abandonedSignups: abandoned.completed,
      overdueDeletions: overdue.completed,
      stuckPurges: stuck.completed,
      failures,
    };

    logger.info("Daily account cleanup completed.", summary);
    if (failures > 0) {
      throw new Error("One or more account cleanup operations failed.");
    }
  },
);

/**
 * Claims stale pending Google signups, then removes Auth users and documents.
 *
 * @param {Timestamp} cutoff Latest creation time eligible for cleanup.
 * @return {Promise<CleanupResult>} Completed and failed operation counts.
 */
async function cleanupAbandonedSignups(
  cutoff: Timestamp,
): Promise<CleanupResult> {
  // The seven-day cutoff is provisional per auth.md sections 4.3 and 8.
  const snapshots = await usersCollection
    .where("status", "==", USER_STATUS.PENDING_ADDITIONAL_INFO)
    .get();
  let completed = 0;
  let failures = 0;

  for (const candidate of snapshots.docs) {
    const uid = candidate.id;
    try {
      const deleted = await deleteAbandonedSignupDocument(uid, cutoff);
      if (!deleted) {
        continue;
      }
      completed += 1;
    } catch {
      failures += 1;
      logger.error("Failed to clean up an abandoned Google signup.", {uid});
    }
  }
  return {completed, failures};
}

/**
 * Claims and deletes one signup only while it remains stale and pending.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @param {Timestamp} cutoff Latest creation time eligible for cleanup.
 * @return {Promise<boolean>} Whether the signup was claimed and deleted.
 */
async function deleteAbandonedSignupDocument(
  uid: string,
  cutoff: Timestamp,
): Promise<boolean> {
  const reference = userDocument(uid);
  const claimed = await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return false;
    }

    const user = snapshot.data() as UserDocument;
    if (
      user.status !== USER_STATUS.PENDING_ADDITIONAL_INFO ||
      !isTimestampAtOrBefore(user.createdAt, cutoff)
    ) {
      return false;
    }

    transaction.update(reference, {
      status: USER_STATUS.PURGING,
      updatedAt: Timestamp.now(),
    });
    return true;
  });

  if (!claimed) {
    return false;
  }

  // A failure deliberately leaves the Firestore document in "purging".
  await deleteAuthUserIfPresent(uid);
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return true;
    }

    const user = snapshot.data() as UserDocument;
    if (user.status !== USER_STATUS.PURGING) {
      return false;
    }

    transaction.delete(reference);
    return true;
  });
}

/**
 * Applies the normal guarded purge path to overdue deletion requests.
 *
 * @param {Timestamp} now Current cleanup time.
 * @return {Promise<CleanupResult>} Completed and failed operation counts.
 */
async function purgeOverdueAccounts(
  now: Timestamp,
): Promise<CleanupResult> {
  const snapshots = await usersCollection
    .where("status", "==", USER_STATUS.PENDING_DELETION)
    .get();
  let completed = 0;
  let failures = 0;

  for (const candidate of snapshots.docs) {
    const uid = candidate.id;
    try {
      if (await purgePendingAccount(uid, now)) {
        completed += 1;
      }
    } catch {
      failures += 1;
      logger.error("Failed to purge an overdue account.", {uid});
    }
  }
  return {completed, failures};
}

/**
 * Retries Auth and Firestore deletion for provisionally stale purging users.
 *
 * @param {Timestamp} cutoff Latest updated time eligible for retry.
 * @return {Promise<CleanupResult>} Completed and failed operation counts.
 */
async function retryStuckPurges(
  cutoff: Timestamp,
): Promise<CleanupResult> {
  const snapshots = await usersCollection
    .where("status", "==", USER_STATUS.PURGING)
    .get();
  let completed = 0;
  let failures = 0;

  for (const candidate of snapshots.docs) {
    const uid = candidate.id;
    try {
      if (await retryStuckPurge(uid, cutoff)) {
        completed += 1;
      }
    } catch {
      failures += 1;
      logger.error("Failed to retry a stuck account purge.", {uid});
    }
  }
  return {completed, failures};
}

/**
 * Best-effort retry for one purging account past the provisional threshold.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @param {Timestamp} cutoff Latest updated time eligible for retry.
 * @return {Promise<boolean>} Whether the purging document is now absent.
 */
async function retryStuckPurge(
  uid: string,
  cutoff: Timestamp,
): Promise<boolean> {
  const reference = userDocument(uid);
  const eligible = await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return false;
    }

    const user = snapshot.data() as UserDocument;
    return (
      user.status === USER_STATUS.PURGING &&
      isTimestampAtOrBefore(user.updatedAt, cutoff)
    );
  });

  if (!eligible) {
    return false;
  }

  await deleteAuthUserIfPresent(uid);
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return true;
    }

    const user = snapshot.data() as UserDocument;
    if (user.status !== USER_STATUS.PURGING) {
      return false;
    }

    transaction.delete(reference);
    return true;
  });
}

/**
 * Compares a Firestore timestamp against an inclusive cutoff.
 *
 * @param {unknown} value Candidate timestamp.
 * @param {Timestamp} cutoff Inclusive cutoff.
 * @return {boolean} Whether the timestamp is valid and old enough.
 */
function isTimestampAtOrBefore(
  value: unknown,
  cutoff: Timestamp,
): value is Timestamp {
  return value instanceof Timestamp && value.toMillis() <= cutoff.toMillis();
}
