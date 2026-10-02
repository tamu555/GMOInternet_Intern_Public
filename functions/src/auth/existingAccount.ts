/**
 * Shared "does an Auth account already exist for this address?" check.
 *
 * Used by both `registerWithEmailPassword` (the original check, run right
 * before account creation - kept as a second line of defence) and
 * `startEmailVerification` (spec 4.1: the wizard now tells the visitor at
 * step 1 instead of letting them fill in the whole form only to fail on the
 * confirm screen). Both call sites share this module so the "already-exists"
 * decision - including the pending_deletion / purging wording - never drifts
 * between them. Neither caller may use this to create a user; it only reads.
 */
import type {Auth, UserRecord} from "firebase-admin/auth";
import type {DocumentReference} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";

import {USER_STATUS} from "./constants.js";
import type {UserDocument} from "./types.js";

export const ALREADY_EXISTS_MESSAGE =
  "An account with this email already exists. Sign in with Google if that " +
  "was the original sign-in method.";
export const DELETION_IN_PROGRESS_MESSAGE = "The account is being deleted.";

export interface ExistingAccountDependencies {
  auth: () => Auth;
  userDocument: (uid: string) => DocumentReference<UserDocument>;
}

/**
 * Checks an SDK error code without trusting the thrown value's shape.
 *
 * @param {unknown} error Thrown value.
 * @param {string} code Expected Firebase error code.
 * @return {boolean} Whether the error carries the expected code.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (error as {code?: unknown}).code === code;
}

/**
 * Extracts only a non-sensitive error code for server-side logging.
 *
 * @param {unknown} error Thrown value.
 * @return {string} SDK error code or unknown.
 */
export function getSafeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }

  const errorCode = (error as {code?: unknown}).code;
  return typeof errorCode === "string" ? errorCode : "unknown";
}

/**
 * Finds an existing Auth account while handling user-not-found explicitly.
 *
 * @param {string} email Email address to find.
 * @param {ExistingAccountDependencies} deps Auth/Firestore accessors.
 * @param {string} lookupFailedMessage Client-safe message for an unexpected
 * lookup failure; each caller words this for its own Callable.
 * @return {Promise<UserRecord|null>} Existing user or null.
 */
export async function findExistingUser(
  email: string,
  deps: ExistingAccountDependencies,
  lookupFailedMessage: string,
): Promise<UserRecord | null> {
  try {
    return await deps.auth().getUserByEmail(email);
  } catch (error: unknown) {
    if (hasErrorCode(error, "auth/user-not-found")) {
      return null;
    }

    logger.error("Failed to check for an existing Auth account.", {
      errorCode: getSafeErrorCode(error),
    });
    throw new HttpsError("internal", lookupFailedMessage);
  }
}

/**
 * Throws the client-safe error for a previously registered account.
 *
 * @param {UserRecord} existingUser Existing Firebase Auth user.
 * @param {ExistingAccountDependencies} deps Auth/Firestore accessors.
 * @return {Promise<never>} This function always rejects.
 */
export async function throwExistingAccountError(
  existingUser: UserRecord,
  deps: ExistingAccountDependencies,
): Promise<never> {
  try {
    const snapshot = await deps.userDocument(existingUser.uid).get();
    const status = snapshot.data()?.status;
    if (status === USER_STATUS.PENDING_DELETION ||
        status === USER_STATUS.PURGING) {
      throw new HttpsError("already-exists", DELETION_IN_PROGRESS_MESSAGE);
    }
  } catch (error: unknown) {
    if (error instanceof HttpsError) {
      throw error;
    }

    logger.error("Failed to inspect an existing user document.", {
      errorCode: getSafeErrorCode(error),
    });
  }

  throw new HttpsError("already-exists", ALREADY_EXISTS_MESSAGE);
}

/**
 * Rejects with `already-exists` when an Auth account already holds this
 * address; resolves silently when the address is free. Never creates a user
 * - existence-only check, safe to call before any signup side effect.
 *
 * @param {string} email Email address to check.
 * @param {ExistingAccountDependencies} deps Auth/Firestore accessors.
 * @param {string} lookupFailedMessage Client-safe message for an unexpected
 * lookup failure.
 * @return {Promise<void>} Resolves when no account holds this address.
 */
export async function rejectIfAccountExists(
  email: string,
  deps: ExistingAccountDependencies,
  lookupFailedMessage: string,
): Promise<void> {
  const existingUser = await findExistingUser(
    email,
    deps,
    lookupFailedMessage,
  );
  if (existingUser) {
    await throwExistingAccountError(existingUser, deps);
  }
}
