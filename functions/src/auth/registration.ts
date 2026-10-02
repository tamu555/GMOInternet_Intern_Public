import type {Auth, UserRecord} from "firebase-admin/auth";
import type {DocumentReference} from "firebase-admin/firestore";
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";

import {adminAuth as auth} from "../config/firebase.js";
import {
  isAllowedEmailDomain,
  isValidEmailAddress,
} from "./auth-helpers.js";
import {AUTH_PROVIDER, USER_STATUS} from "./constants.js";
import {
  ALREADY_EXISTS_MESSAGE,
  getSafeErrorCode,
  hasErrorCode,
  rejectIfAccountExists,
} from "./existingAccount.js";
import {userDocument, verificationDocument} from "./firestore.js";
import {registrationInputSchema} from "./profileSchema.js";
import {
  assertEmailVerified,
  consumeEmailVerification,
} from "./verification.js";
import type {
  UserDocument,
  UserProfile,
  VerificationCodeDocument,
} from "./types.js";

type RegistrationInput = {
  email: string;
  password: string;
} & UserProfile;

export interface RegisterWithEmailPasswordDependencies {
  auth: () => Auth;
  userDocument: (uid: string) => DocumentReference<UserDocument>;
  verificationDocument: (
    email: string,
  ) => DocumentReference<VerificationCodeDocument>;
  now: () => Timestamp;
}

const defaultDeps: RegisterWithEmailPasswordDependencies = {
  auth,
  now: () => Timestamp.now(),
  userDocument,
  verificationDocument,
};

const INVALID_REGISTRATION_MESSAGE = "Invalid registration information.";
const REGISTRATION_FAILED_MESSAGE = "Registration could not be completed.";

/**
 * Parses and validates full-profile email/password registration input.
 *
 * @param {unknown} data Callable request data.
 * @return {RegistrationInput} Validated registration input.
 */
function parseRegistrationInput(data: unknown): RegistrationInput {
  const parsed = registrationInputSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn("Registration input failed validation.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    throw new HttpsError("invalid-argument", INVALID_REGISTRATION_MESSAGE);
  }

  const input = parsed.data as RegistrationInput;
  if (!isValidEmailAddress(input.email) ||
      !isAllowedEmailDomain(input.email)) {
    // Logged like the schema branch above: without it this rejection is
    // indistinguishable from a healthy call in the emulator output, and the
    // client only ever sees the generic invalid-argument message. The address
    // itself stays out of the log; the reason is what was missing.
    logger.warn("Registration input failed validation.", {
      issues: [{path: "email", code: "disallowed_domain"}],
    });
    throw new HttpsError("invalid-argument", INVALID_REGISTRATION_MESSAGE);
  }

  return input;
}

/**
 * Creates the Firebase Auth user and maps failures to client-safe errors.
 *
 * @param {RegistrationInput} input Validated registration input.
 * @param {RegisterWithEmailPasswordDependencies} deps Handler dependencies.
 * @return {Promise<UserRecord>} Newly created Firebase Auth user.
 */
async function createAuthUser(
  input: RegistrationInput,
  deps: RegisterWithEmailPasswordDependencies,
): Promise<UserRecord> {
  try {
    return await deps.auth().createUser({
      email: input.email,
      password: input.password,
    });
  } catch (error: unknown) {
    if (hasErrorCode(error, "auth/email-already-exists")) {
      throw new HttpsError("already-exists", ALREADY_EXISTS_MESSAGE);
    }
    if (hasErrorCode(error, "auth/invalid-email") ||
        hasErrorCode(error, "auth/invalid-password")) {
      throw new HttpsError("invalid-argument", INVALID_REGISTRATION_MESSAGE);
    }

    logger.error("Failed to create an Auth account.", {
      errorCode: getSafeErrorCode(error),
    });
    throw new HttpsError("internal", REGISTRATION_FAILED_MESSAGE);
  }
}

/**
 * Builds the nested profile object from validated registration input.
 *
 * @param {RegistrationInput} input Validated registration input.
 * @return {UserProfile} The full profile to persist.
 */
function buildUserProfile(input: RegistrationInput): UserProfile {
  return {
    name: input.name,
    nameKana: input.nameKana,
    phoneNumber: input.phoneNumber,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    newsletterOptIn: input.newsletterOptIn,
    accountType: input.accountType,
    business: input.business,
    address: input.address,
  };
}

/**
 * Writes the active user document and compensates if the write fails.
 *
 * @param {UserRecord} createdUser Newly created Firebase Auth user.
 * @param {RegistrationInput} input Validated registration input.
 * @param {RegisterWithEmailPasswordDependencies} deps Handler dependencies.
 * @return {Promise<void>} Resolves after the user document is created.
 */
async function writeUserDocument(
  createdUser: UserRecord,
  input: RegistrationInput,
  deps: RegisterWithEmailPasswordDependencies,
): Promise<void> {
  const now = Timestamp.now();
  const user: UserDocument = {
    uid: createdUser.uid,
    email: createdUser.email ?? input.email,
    authProvider: AUTH_PROVIDER.PASSWORD,
    status: USER_STATUS.ACTIVE,
    profile: buildUserProfile(input),
    createdAt: now,
    updatedAt: now,
    deletionRequestedAt: null,
    scheduledPurgeAt: null,
    purgeTaskName: null,
  };

  try {
    await deps.userDocument(createdUser.uid).create(user);
  } catch (error: unknown) {
    logger.error("Failed to create a user document; compensating.", {
      errorCode: getSafeErrorCode(error),
    });
    try {
      await deps.auth().deleteUser(createdUser.uid);
    } catch (compensationError: unknown) {
      logger.error(
        "Failed to compensate for a user document write failure.",
        {errorCode: getSafeErrorCode(compensationError)},
      );
    }
    throw new HttpsError("internal", REGISTRATION_FAILED_MESSAGE);
  }
}

/**
 * Handles full-profile email/password registration.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {RegisterWithEmailPasswordDependencies} deps Handler dependencies.
 * @return {Promise<{uid: string, status: "active"}>} The created account.
 */
export async function handleRegisterWithEmailPassword(
  request: CallableRequest<unknown>,
  deps: RegisterWithEmailPasswordDependencies = defaultDeps,
): Promise<{uid: string; status: "active"}> {
  const input = parseRegistrationInput(request.data);
  // Before anything is created: the wizard's step 2 is a server-side
  // precondition, not a screen the client may decide to skip.
  await assertEmailVerified(input.email, deps);

  // Second line of defence: `startEmailVerification` already ran this same
  // check at step 1 (existingAccount.ts), but nothing stops a caller from
  // reaching this Callable directly, and the address could have been
  // registered by another request in between the two calls.
  await rejectIfAccountExists(input.email, deps, REGISTRATION_FAILED_MESSAGE);

  const createdUser = await createAuthUser(input, deps);
  await writeUserDocument(createdUser, input, deps);
  // One grant, one account: spending it here stops a leaked-but-still-live
  // grant from being replayed into a second registration attempt.
  await consumeEmailVerification(input.email, deps);

  return {
    uid: createdUser.uid,
    status: USER_STATUS.ACTIVE,
  };
}

export const registerWithEmailPassword = onCall((request) =>
  handleRegisterWithEmailPassword(request),
);
