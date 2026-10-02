import {randomUUID} from "node:crypto";

import type {Firestore, DocumentReference} from "firebase-admin/firestore";
import {getFunctions} from "firebase-admin/functions";
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";

import {adminAuth as auth, db} from "../config/firebase.js";
import {REGION} from "../config/options.js";
import {
  AUTH_PROVIDER,
  MILLISECONDS_PER_SECOND,
  PURGE_DELAY_SECONDS,
  USER_STATUS,
} from "./constants.js";
import {userDocument} from "./firestore.js";
import {
  canRestoreAccount,
  canTransitionToPurging,
  isAuthTimeFresh,
  matchesDeletionAttempt,
} from "./auth-helpers.js";
import {additionalInfoInputSchema} from "./profileSchema.js";
import {deriveDomainLifecycle, ownedDomainsQuery} from
  "../domain/domainRepository.js";
import type {AuthProvider, UserDocument, UserProfile} from "./types.js";

export interface SubmitAdditionalInfoDependencies {
  db: () => Firestore;
  userDocument: (uid: string) => DocumentReference<UserDocument>;
}

const defaultSubmitAdditionalInfoDeps: SubmitAdditionalInfoDependencies = {
  db,
  userDocument,
};

interface PurgeTaskData {
  uid?: unknown;
}

interface DeletionPreparation {
  deletionRequestedAt: Timestamp;
  scheduledPurgeAt: Timestamp;
  purgeTaskName: string;
}

const PURGE_DELAY_MILLISECONDS =
  PURGE_DELAY_SECONDS * MILLISECONDS_PER_SECOND;

/** Client-facing message for a deletion request blocked by domain ownership. */
const DOMAINS_OWNED_MESSAGE =
  "保有中のドメインがあるため退会できません。先にドメインを廃止または移管し" +
  "てください。";

/**
 * Dependencies the deletion-request flow needs, substitutable in tests so it
 * can run without a live Firestore/Cloud Tasks/Auth connection.
 *
 * `runTransaction` and `userDocument` are shared by every transaction this
 * flow runs (`prepareDeletion`, `compensateFailedEnqueue`,
 * `isDeletionGenerationPending`) rather than each hard-coding `db()`, so one
 * fake can drive the whole request end to end.
 */
export interface AccountDeletionDependencies {
  runTransaction: <T>(
    updateFunction: (transaction: FirebaseFirestore.Transaction) => Promise<T>,
  ) => Promise<T>;
  userDocument: (uid: string) => DocumentReference<UserDocument>;
  /**
   * Counts the caller's still-owned domains from *inside* the same
   * Firestore transaction `prepareDeletion` uses to flip `users/{uid}` to
   * `pending_deletion`, so a domain created concurrently with the deletion
   * request is either seen by this count or causes the transaction to
   * retry against a fresh snapshot - Firestore transactions detect a
   * conflicting write to any document a query inside them matched, so this
   * is not a plain read-then-write race.
   *
   * Excludes `lifecycle === "gone"` mirrors (a completed outbound transfer,
   * or a deletion whose redemption window already closed): a member who
   * properly retired or transferred away every domain they held must still
   * be able to delete their account, or the UI's own "先にドメインを廃止また
   * は移管してください" guidance would be a dead end with no way through.
   */
  countOwnedDomains: (
    uid: string,
    transaction: FirebaseFirestore.Transaction,
  ) => Promise<number>;
  enqueuePurgeTask: (uid: string, purgeTaskName: string) => Promise<void>;
  revokeRefreshTokens: (uid: string) => Promise<void>;
}

/**
 * Production count of one member's still-owned domains, read inside the
 * caller's `prepareDeletion` transaction from the same tenant-scoped query
 * `listOwnedDomains` uses (`domain/domainRepository.ts`'s
 * `ownedDomainsQuery`), so "owned domain" can never disagree with what the
 * domains list screen shows for the same `uid`.
 *
 * A plain `count()` aggregate cannot express "exclude `gone`" on its own
 * (see `AccountDeletionDependencies.countOwnedDomains`'s doc comment for why
 * `gone` must be excluded), so this instead reads the small per-member
 * projection (`status`/`lifecycle` only - never `authInfo` or any other
 * sensitive field) and applies the same `deriveDomainLifecycle` bucketing
 * `toDomainListItem` uses, which is also what makes a mirror predating the
 * `lifecycle` field fall back to its `status` array correctly instead of
 * being silently miscounted.
 *
 * @param {string} uid Firebase Authentication user id.
 * @param {FirebaseFirestore.Transaction} transaction Enclosing transaction.
 * @return {Promise<number>} Number of still-owned (non-`gone`) domains.
 */
export async function countOwnedDomainsInTransaction(
  uid: string,
  transaction: FirebaseFirestore.Transaction,
): Promise<number> {
  const snapshot = await transaction.get(
    ownedDomainsQuery(uid).select("status", "lifecycle"),
  );
  return snapshot.docs.reduce((count, doc) => {
    const data = doc.data();
    const status = Array.isArray(data.status) ? (data.status as string[]) : [];
    const lifecycle = deriveDomainLifecycle(data.lifecycle, status);
    return lifecycle === "gone" ? count : count + 1;
  }, 0);
}

/**
 * Production purge-task enqueue: schedules the delayed Cloud Task that
 * eventually calls `purgePendingAccount`.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @param {string} purgeTaskName Pre-generated Cloud Tasks identifier.
 * @return {Promise<void>} Resolves once the task is scheduled.
 */
async function enqueuePurgeTaskInProduction(
  uid: string,
  purgeTaskName: string,
): Promise<void> {
  await getFunctions()
    .taskQueue<PurgeTaskData>(
      `locations/${REGION}/functions/purgeAccount`,
    )
    .enqueue(
      {uid},
      {
        scheduleDelaySeconds: PURGE_DELAY_SECONDS,
        id: purgeTaskName,
      },
    );
}

const defaultAccountDeletionDeps: AccountDeletionDependencies = {
  countOwnedDomains: countOwnedDomainsInTransaction,
  enqueuePurgeTask: enqueuePurgeTaskInProduction,
  revokeRefreshTokens: (uid) => auth().revokeRefreshTokens(uid),
  runTransaction: (updateFunction) => db().runTransaction(updateFunction),
  userDocument,
};

/**
 * Returns true when an Auth user is absent after the call.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @return {Promise<void>} Resolves when the Auth user is absent.
 */
export async function deleteAuthUserIfPresent(uid: string): Promise<void> {
  try {
    await auth().deleteUser(uid);
  } catch (error: unknown) {
    if (isAuthUserNotFound(error)) {
      return;
    }
    throw error;
  }
}

/**
 * Serializes purge against restore, then physically deletes both records.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @param {Timestamp|undefined} dueAt Optional cleanup safety-net cutoff.
 * @return {Promise<boolean>} Whether this invocation claimed the purge.
 */
export async function purgePendingAccount(
  uid: string,
  dueAt?: Timestamp,
): Promise<boolean> {
  const reference = userDocument(uid);
  const transitioned = await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return false;
    }

    const user = snapshot.data() as UserDocument;
    if (!canTransitionToPurging(user.status)) {
      return false;
    }
    if (
      dueAt &&
      (
        !user.scheduledPurgeAt ||
        user.scheduledPurgeAt.toMillis() > dueAt.toMillis()
      )
    ) {
      return false;
    }

    transaction.update(reference, {
      status: USER_STATUS.PURGING,
      updatedAt: Timestamp.now(),
    });
    return true;
  });

  if (!transitioned) {
    return false;
  }

  // A failure deliberately leaves the Firestore document in "purging".
  await auth().deleteUser(uid);
  await reference.delete();
  return true;
}

/**
 * Parses and validates the full-profile additional-info submission.
 *
 * @param {unknown} data Callable request data.
 * @return {UserProfile} Validated full profile.
 */
function parseAdditionalInfoInput(data: unknown): UserProfile {
  const parsed = additionalInfoInputSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn("Additional information input failed validation.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    throw new HttpsError(
      "invalid-argument",
      "Required information is missing.",
    );
  }

  return parsed.data;
}

/**
 * Handles a Google user's full-profile additional-info submission.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {SubmitAdditionalInfoDependencies} deps Handler dependencies.
 * @return {Promise<{status: "active"}>} The completed account status.
 */
export async function handleSubmitAdditionalInfo(
  request: CallableRequest<unknown>,
  deps: SubmitAdditionalInfoDependencies = defaultSubmitAdditionalInfoDeps,
): Promise<{status: "active"}> {
  const uid = requireAuthenticatedUid(request.auth?.uid);
  const profile = parseAdditionalInfoInput(request.data);
  const reference = deps.userDocument(uid);

  try {
    const updated = await deps.db().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        return false;
      }

      const user = snapshot.data() as UserDocument;
      if (
        user.status !== USER_STATUS.PENDING_ADDITIONAL_INFO ||
        user.authProvider !== AUTH_PROVIDER.GOOGLE
      ) {
        return false;
      }

      transaction.update(reference, {
        profile,
        status: USER_STATUS.ACTIVE,
        updatedAt: Timestamp.now(),
      });
      return true;
    });

    if (!updated) {
      throw new HttpsError(
        "failed-precondition",
        "Additional information cannot be submitted.",
      );
    }
    return {status: USER_STATUS.ACTIVE};
  } catch (error: unknown) {
    throwClientSafeError(error, "Additional information could not be saved.");
  }
}

export const submitAdditionalInfo = onCall((request) =>
  handleSubmitAdditionalInfo(request),
);

/**
 * Handles `deleteAccountWithPassword`.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<object>} Pending-deletion response.
 */
export async function handleDeleteAccountWithPassword(
  request: CallableRequest<unknown>,
  deps: AccountDeletionDependencies = defaultAccountDeletionDeps,
): Promise<{status: "pending_deletion"; scheduledPurgeAt: string}> {
  return requestAccountDeletion(
    request.auth?.uid,
    request.auth?.token.auth_time,
    AUTH_PROVIDER.PASSWORD,
    deps,
  );
}

/**
 * Handles `deleteAccountWithGoogle`.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<object>} Pending-deletion response.
 */
export async function handleDeleteAccountWithGoogle(
  request: CallableRequest<unknown>,
  deps: AccountDeletionDependencies = defaultAccountDeletionDeps,
): Promise<{status: "pending_deletion"; scheduledPurgeAt: string}> {
  return requestAccountDeletion(
    request.auth?.uid,
    request.auth?.token.auth_time,
    AUTH_PROVIDER.GOOGLE,
    deps,
  );
}

export const deleteAccountWithPassword = onCall((request) =>
  handleDeleteAccountWithPassword(request),
);

export const deleteAccountWithGoogle = onCall((request) =>
  handleDeleteAccountWithGoogle(request),
);

export const purgeAccount = onTaskDispatched<PurgeTaskData>(
  async (request): Promise<void> => {
    const uid = request.data.uid;
    if (typeof uid !== "string" || uid.length === 0) {
      logger.warn("Ignoring a purge task with an invalid payload.");
      return;
    }

    try {
      await purgePendingAccount(uid);
    } catch (error: unknown) {
      logger.error("Account purge failed after the transaction guard.", {uid});
      throw error;
    }
  },
);

export const restoreAccount = onCall(
  async (request): Promise<{status: "active"}> => {
    const uid = requireAuthenticatedUid(request.auth?.uid);
    requireFreshAuthentication(request.auth?.token.auth_time);
    const reference = userDocument(uid);

    try {
      const restored = await db().runTransaction(async (transaction) => {
        const snapshot = await transaction.get(reference);
        if (!snapshot.exists) {
          return false;
        }

        const user = snapshot.data() as UserDocument;
        const attemptNow = Timestamp.now();
        if (
          !canRestoreAccount(
            user.status,
            user.scheduledPurgeAt,
            attemptNow,
          )
        ) {
          return false;
        }

        transaction.update(reference, {
          status: USER_STATUS.ACTIVE,
          deletionRequestedAt: null,
          scheduledPurgeAt: null,
          purgeTaskName: null,
          updatedAt: attemptNow,
        });
        return true;
      });

      if (!restored) {
        throw new HttpsError(
          "failed-precondition",
          "The account cannot be restored.",
        );
      }
      return {status: USER_STATUS.ACTIVE};
    } catch (error: unknown) {
      throwClientSafeError(error, "The account could not be restored.");
    }
  },
);

/**
 * Validates, schedules, and immediately revokes an account deletion request.
 *
 * @param {string|undefined} maybeUid Authenticated user ID.
 * @param {unknown} authTime Firebase auth_time claim.
 * @param {AuthProvider} expectedProvider Required stored provider.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<object>} Pending-deletion response.
 */
async function requestAccountDeletion(
  maybeUid: string | undefined,
  authTime: unknown,
  expectedProvider: AuthProvider,
  deps: AccountDeletionDependencies,
): Promise<{status: "pending_deletion"; scheduledPurgeAt: string}> {
  const uid = requireAuthenticatedUid(maybeUid);
  requireFreshAuthentication(authTime);
  const purgeTaskName = randomUUID();

  let preparation: DeletionPreparation;
  try {
    preparation = await prepareDeletion(
      uid,
      expectedProvider,
      purgeTaskName,
      deps,
    );
  } catch (error: unknown) {
    throwClientSafeError(error, "The deletion request could not be processed.");
  }

  try {
    await deps.enqueuePurgeTask(uid, preparation.purgeTaskName);
  } catch {
    logger.error("Failed to enqueue an account purge task.", {uid});
    try {
      await compensateFailedEnqueue(
        uid,
        preparation.deletionRequestedAt,
        preparation.scheduledPurgeAt,
        deps,
      );
    } catch {
      logger.error("Failed to compensate an account deletion request.", {uid});
    }
    throw new HttpsError("internal", "The deletion request failed.");
  }

  try {
    await deps.revokeRefreshTokens(uid);
  } catch {
    logger.error("Failed to revoke tokens after an account deletion request.", {
      uid,
    });
    try {
      await compensateFailedEnqueue(
        uid,
        preparation.deletionRequestedAt,
        preparation.scheduledPurgeAt,
        deps,
      );
    } catch {
      logger.error("Failed to compensate an account deletion request.", {uid});
    }
    throw new HttpsError("internal", "The deletion request failed.");
  }

  let deletionStillPending: boolean;
  try {
    deletionStillPending = await isDeletionGenerationPending(
      uid,
      preparation.deletionRequestedAt,
      preparation.scheduledPurgeAt,
      preparation.purgeTaskName,
      deps,
    );
  } catch {
    logger.error("Failed to verify an account deletion request.", {uid});
    throw new HttpsError("internal", "The deletion request failed.");
  }
  if (!deletionStillPending) {
    throw new HttpsError(
      "failed-precondition",
      "The deletion request is no longer pending.",
    );
  }

  return {
    status: USER_STATUS.PENDING_DELETION,
    scheduledPurgeAt: preparation.scheduledPurgeAt.toDate().toISOString(),
  };
}

/**
 * Claims an active account for delayed deletion in a transaction, refusing
 * while the member still owns any domain (spec: account-deletion-domain-
 * handling gap 1/2 - an orphaned auto-renewing domain keeps billing at the
 * registry with nobody left able to turn it off).
 *
 * The domain-ownership count runs *inside* this same transaction, alongside
 * the read that decides `provider`/`status`, so the whole decision - and the
 * `pending_deletion` write it may lead to - is one atomic unit: a domain
 * created concurrently either lands inside this transaction's read set (and
 * is counted) or forces Firestore to retry the transaction against a fresh
 * snapshot. There is no window where this function can commit
 * `pending_deletion` while a domain the same read would have seen already
 * exists.
 *
 * @param {string} uid Authenticated user ID.
 * @param {AuthProvider} expectedProvider Required stored provider.
 * @param {string} purgeTaskName Pre-generated Cloud Tasks identifier.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<DeletionPreparation>} Scheduled deletion metadata.
 */
async function prepareDeletion(
  uid: string,
  expectedProvider: AuthProvider,
  purgeTaskName: string,
  deps: AccountDeletionDependencies,
): Promise<DeletionPreparation> {
  const reference = deps.userDocument(uid);
  const now = Timestamp.now();
  const scheduledPurgeAt = Timestamp.fromMillis(
    now.toMillis() + PURGE_DELAY_MILLISECONDS,
  );

  const result = await deps.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return "unavailable" as const;
    }

    const user = snapshot.data() as UserDocument;
    if (user.authProvider !== expectedProvider) {
      return "provider_mismatch" as const;
    }
    if (user.status !== USER_STATUS.ACTIVE) {
      return "unavailable" as const;
    }

    const ownedDomainCount = await deps.countOwnedDomains(uid, transaction);
    if (ownedDomainCount > 0) {
      // Thrown, not returned: this must abort the transaction outright so
      // the caller sees the domain count and reason, not the generic
      // "cannot be deleted" message the string outcomes below map to.
      throw new HttpsError(
        "failed-precondition",
        DOMAINS_OWNED_MESSAGE,
        {reason: "domains_owned", count: ownedDomainCount},
      );
    }

    transaction.update(reference, {
      status: USER_STATUS.PENDING_DELETION,
      deletionRequestedAt: now,
      scheduledPurgeAt,
      purgeTaskName,
      updatedAt: now,
    });
    return "prepared" as const;
  });

  if (result === "provider_mismatch") {
    throw new HttpsError("permission-denied", "The account cannot be deleted.");
  }
  if (result !== "prepared") {
    throw new HttpsError(
      "failed-precondition",
      "The account cannot be deleted.",
    );
  }
  return {
    deletionRequestedAt: now,
    scheduledPurgeAt,
    purgeTaskName,
  };
}

/**
 * Rolls a deletion request back when its task cannot be enqueued.
 *
 * @param {string} uid Authenticated user ID.
 * @param {Timestamp} expectedRequestedAt Expected deletion request time.
 * @param {Timestamp} expectedPurgeAt Expected deletion-generation deadline.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<void>} Resolves after the guarded compensation.
 */
async function compensateFailedEnqueue(
  uid: string,
  expectedRequestedAt: Timestamp,
  expectedPurgeAt: Timestamp,
  deps: AccountDeletionDependencies,
): Promise<void> {
  const reference = deps.userDocument(uid);
  await deps.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return;
    }

    const user = snapshot.data() as UserDocument;
    if (
      !matchesDeletionAttempt(
        user.status,
        user.deletionRequestedAt,
        user.scheduledPurgeAt,
        expectedRequestedAt,
        expectedPurgeAt,
      )
    ) {
      return;
    }

    transaction.update(reference, {
      status: USER_STATUS.ACTIVE,
      deletionRequestedAt: null,
      scheduledPurgeAt: null,
      purgeTaskName: null,
      updatedAt: Timestamp.now(),
    });
  });
}

/**
 * Establishes the deletion response's Firestore linearization point.
 *
 * @param {string} uid Authenticated user ID.
 * @param {Timestamp} expectedRequestedAt Expected deletion request time.
 * @param {Timestamp} expectedPurgeAt Expected deletion-generation deadline.
 * @param {string} expectedTaskName Expected deletion-generation task ID.
 * @param {AccountDeletionDependencies} deps Handler dependencies.
 * @return {Promise<boolean>} Whether this deletion generation is still pending.
 */
async function isDeletionGenerationPending(
  uid: string,
  expectedRequestedAt: Timestamp,
  expectedPurgeAt: Timestamp,
  expectedTaskName: string,
  deps: AccountDeletionDependencies,
): Promise<boolean> {
  const reference = deps.userDocument(uid);
  return deps.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      return false;
    }

    return matchesDeletionGeneration(
      snapshot.data() as UserDocument,
      expectedRequestedAt,
      expectedPurgeAt,
      expectedTaskName,
    );
  });
}

/**
 * Correlates a Firestore record to one deletion request generation.
 *
 * @param {UserDocument} user Stored user record.
 * @param {Timestamp} expectedRequestedAt Expected deletion request time.
 * @param {Timestamp} expectedPurgeAt Expected deletion-generation deadline.
 * @param {string} expectedTaskName Expected deletion-generation task ID.
 * @return {boolean} Whether status, deadline, and task ID all match.
 */
function matchesDeletionGeneration(
  user: UserDocument,
  expectedRequestedAt: Timestamp,
  expectedPurgeAt: Timestamp,
  expectedTaskName: string,
): boolean {
  return (
    matchesDeletionAttempt(
      user.status,
      user.deletionRequestedAt,
      user.scheduledPurgeAt,
      expectedRequestedAt,
      expectedPurgeAt,
    ) &&
    user.purgeTaskName === expectedTaskName
  );
}

/**
 * Requires Callable authentication and returns its user ID.
 *
 * @param {string|undefined} uid Callable authentication user ID.
 * @return {string} Authenticated user ID.
 */
function requireAuthenticatedUid(uid: string | undefined): string {
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }
  return uid;
}

/**
 * Requires a recently reauthenticated Callable ID token.
 *
 * @param {unknown} authTime Firebase auth_time claim.
 * @return {void}
 */
function requireFreshAuthentication(authTime: unknown): void {
  // Provisional five-minute window from auth.md sections 4.8, 4.9, and 8.
  if (
    !isAuthTimeFresh(
      authTime,
      Date.now() / 1000,
    )
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Recent authentication is required.",
    );
  }
}

/**
 * Preserves HttpsError instances and hides all other implementation details.
 *
 * @param {unknown} error Thrown value.
 * @param {string} message Stable generic client-facing message.
 */
function throwClientSafeError(error: unknown, message: string): never {
  if (error instanceof HttpsError) {
    throw error;
  }
  logger.error(message);
  throw new HttpsError("internal", message);
}

/**
 * Checks an SDK error without trusting the thrown value's shape.
 *
 * @param {unknown} error Thrown value.
 * @return {boolean} Whether Auth reports that the user is absent.
 */
function isAuthUserNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "auth/user-not-found"
  );
}
