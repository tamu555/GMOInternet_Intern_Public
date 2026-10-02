/**
 * Signup wizard step 2: e-mail verification codes.
 *
 * Three Callables issue and check a six-digit code held in
 * `verificationCodes/{email}`:
 *   - `startEmailVerification`   idempotent, called when step 1 is submitted
 *   - `resendEmailVerificationCode` always mints a new code, rate limited
 *   - `verifyEmailCode`          checks one submission, grants verification
 *
 * `registration.ts` then refuses to create an account for an address that
 * holds no valid grant, so the step cannot be skipped by calling the
 * registration Callable directly.
 *
 * `startEmailVerification` also checks (existence only, never creation - see
 * existingAccount.ts) whether the address already holds an Auth account,
 * before writing or reading anything under `verificationCodes/{email}`; this
 * lets the wizard say so at step 1 instead of only at the final confirm
 * screen, where `registerWithEmailPassword` runs the same check again as a
 * second line of defence.
 *
 * Delivery note: nothing sends mail in this project. The document is
 * world-readable by `get` (firestore.rules) so the visitor can read the code
 * for the address they typed - a deliberate, recorded trade-off, not an
 * oversight. Because of it these Callables never echo the code back: the
 * only way to obtain it is the Firestore read the rules allow.
 */
import type {Auth} from "firebase-admin/auth";
import {Timestamp} from "firebase-admin/firestore";
import type {DocumentReference} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";

import {adminAuth as auth, db} from "../config/firebase.js";
import {
  isAllowedEmailDomain,
  isValidEmailAddress,
} from "./auth-helpers.js";
import {
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_GRANT_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_RESEND_INTERVAL_MS,
} from "./constants.js";
import {rejectIfAccountExists} from "./existingAccount.js";
import {userDocument, verificationDocument} from "./firestore.js";
import {
  codesMatch,
  generateVerificationCode,
  isCodeSubmittable,
  isResendAllowed,
  isSafeVerificationDocumentId,
  isVerificationGrantValid,
  isWellFormedVerificationCode,
  normaliseVerificationEmail,
} from "./verificationCodes.js";
import type {UserDocument, VerificationCodeDocument} from "./types.js";

const INVALID_EMAIL_MESSAGE =
  "A valid e-mail address on an allowed domain is required.";
const INVALID_CODE_FORMAT_MESSAGE = "The verification code is malformed.";
const RESEND_TOO_SOON_MESSAGE =
  "A verification code was sent recently; please wait before requesting " +
  "another one.";
const NO_CODE_MESSAGE = "No verification code has been issued.";
const CODE_EXPIRED_MESSAGE = "The verification code has expired.";
const GRANT_EXPIRED_MESSAGE = "The verification has expired.";
const ATTEMPTS_EXHAUSTED_MESSAGE =
  "Too many incorrect attempts; request a new verification code.";
const WRONG_CODE_MESSAGE = "The verification code is incorrect.";
export const EMAIL_NOT_VERIFIED_MESSAGE =
  "The e-mail address has not been verified.";
const START_LOOKUP_FAILED_MESSAGE =
  "Could not check whether this e-mail address is already registered.";

export interface EmailVerificationDependencies {
  verificationDocument: (
    email: string,
  ) => DocumentReference<VerificationCodeDocument>;
  runTransaction: <T>(
    updateFunction: (
      transaction: FirebaseFirestore.Transaction,
    ) => Promise<T>,
  ) => Promise<T>;
  now: () => Timestamp;
  generateCode: () => string;
  /** Existence check only (spec 4.1) - never used to create a user. */
  auth: () => Auth;
  userDocument: (uid: string) => DocumentReference<UserDocument>;
}

const defaultDeps: EmailVerificationDependencies = {
  auth,
  generateCode: generateVerificationCode,
  now: () => Timestamp.now(),
  runTransaction: (updateFunction) => db().runTransaction(updateFunction),
  userDocument,
  verificationDocument,
};

/** What the Callables tell the client. Never includes the code itself. */
export interface VerificationStatus {
  email: string;
  /** Epoch milliseconds; the client renders a countdown from these. */
  expiresAt: number;
  resendAvailableAt: number;
  attemptsRemaining: number;
  verified: boolean;
}

/**
 * Reads and validates the address out of a Callable payload.
 *
 * @param {unknown} data Callable request data.
 * @return {string} Normalised address.
 */
function parseEmail(data: unknown): string {
  const email = (data as {email?: unknown} | null)?.email;
  if (typeof email !== "string") {
    throw new HttpsError("invalid-argument", INVALID_EMAIL_MESSAGE);
  }

  const normalised = normaliseVerificationEmail(email);
  // Spec 3.4: the local part is free, the domain is not. Checked with the
  // same helper registration.ts uses, so an address that can be verified is
  // always an address that can be registered.
  if (!isValidEmailAddress(normalised) ||
      !isAllowedEmailDomain(normalised) ||
      !isSafeVerificationDocumentId(normalised)) {
    throw new HttpsError("invalid-argument", INVALID_EMAIL_MESSAGE);
  }

  return normalised;
}

/**
 * Projects a stored document onto the client-facing status.
 *
 * @param {VerificationCodeDocument} document Stored verification document.
 * @return {VerificationStatus} Client-facing status.
 */
function toStatus(document: VerificationCodeDocument): VerificationStatus {
  return {
    attemptsRemaining: document.attemptsRemaining,
    email: document.email,
    expiresAt: document.expiresAt.toMillis(),
    resendAvailableAt: document.resendAvailableAt.toMillis(),
    verified: document.verified,
  };
}

/**
 * Builds a brand-new verification document for one address.
 *
 * @param {string} email Normalised address.
 * @param {Timestamp} now Issue time.
 * @param {Timestamp|undefined} createdAt Original creation time, if any.
 * @param {EmailVerificationDependencies} deps Handler dependencies.
 * @return {VerificationCodeDocument} The document to store.
 */
function buildDocument(
  email: string,
  now: Timestamp,
  createdAt: Timestamp | undefined,
  deps: EmailVerificationDependencies,
): VerificationCodeDocument {
  const nowMs = now.toMillis();
  return {
    attemptsRemaining: VERIFICATION_MAX_ATTEMPTS,
    code: deps.generateCode(),
    createdAt: createdAt ?? now,
    email,
    expiresAt: Timestamp.fromMillis(nowMs + VERIFICATION_CODE_TTL_MS),
    resendAvailableAt: Timestamp.fromMillis(
      nowMs + VERIFICATION_RESEND_INTERVAL_MS,
    ),
    updatedAt: now,
    verified: false,
    verifiedUntil: null,
  };
}

/**
 * Issues a code, either idempotently (start) or unconditionally (resend).
 *
 * @param {string} email Normalised address.
 * @param {"start"|"resend"} mode Which entry point asked for a code.
 * @param {EmailVerificationDependencies} deps Handler dependencies.
 * @return {Promise<VerificationStatus>} Status of the live code.
 */
async function issueCode(
  email: string,
  mode: "start" | "resend",
  deps: EmailVerificationDependencies,
): Promise<VerificationStatus> {
  const reference = deps.verificationDocument(email);

  return deps.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const existing = snapshot.data();
    const now = deps.now();
    const nowMs = now.toMillis();

    if (existing && mode === "start") {
      // Step 1 is re-submitted whenever the visitor goes back to fix a
      // field, so it must not invalidate the code already sitting in front
      // of them, reset the resend cooldown, or - worse - revoke a
      // verification they have already passed.
      if (isVerificationGrantValid(existing, nowMs) ||
          isCodeSubmittable(existing, nowMs)) {
        return toStatus(existing);
      }
    }

    if (existing && mode === "resend" && !isResendAllowed(existing, nowMs)) {
      throw new HttpsError("resource-exhausted", RESEND_TOO_SOON_MESSAGE);
    }

    const document = buildDocument(email, now, existing?.createdAt, deps);
    transaction.set(reference, document);
    return toStatus(document);
  });
}

/**
 * Handles `startEmailVerification`.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {EmailVerificationDependencies} deps Handler dependencies.
 * @return {Promise<VerificationStatus>} Status of the live code.
 */
export async function handleStartEmailVerification(
  request: CallableRequest<unknown>,
  deps: EmailVerificationDependencies = defaultDeps,
): Promise<VerificationStatus> {
  const email = parseEmail(request.data);
  // Spec 4.1: tell the visitor about a duplicate account right here, at
  // step 1, instead of letting them fill in the rest of the wizard only to
  // fail on the final confirm screen when `registerWithEmailPassword` repeats
  // this same check (kept there as a second line of defence - see
  // existingAccount.ts). Existence check only: never creates a user, and runs
  // before any verificationCodes/{email} document is written or read below.
  await rejectIfAccountExists(email, deps, START_LOOKUP_FAILED_MESSAGE);
  return issueCode(email, "start", deps);
}

/**
 * Handles `resendEmailVerificationCode`.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {EmailVerificationDependencies} deps Handler dependencies.
 * @return {Promise<VerificationStatus>} Status of the freshly issued code.
 */
export async function handleResendEmailVerificationCode(
  request: CallableRequest<unknown>,
  deps: EmailVerificationDependencies = defaultDeps,
): Promise<VerificationStatus> {
  return issueCode(parseEmail(request.data), "resend", deps);
}

/** What `verifyEmailCode` answers on success. */
export interface VerificationResult {
  verified: true;
  /** Epoch milliseconds until which registration will accept this grant. */
  verifiedUntil: number;
}

/**
 * Why one submission was refused, or the window it was granted.
 *
 * The transaction returns this instead of throwing, because a thrown error
 * rolls the transaction back - and the wrong-code branch has a write of its
 * own to commit (the decremented attempt counter). Throwing inside would
 * silently give the caller unlimited attempts.
 */
type VerifyOutcome =
  | {status: "verified"; verifiedUntil: number}
  | {status: "noCode"}
  | {status: "grantExpired"}
  | {status: "codeExpired"}
  | {status: "attemptsExhausted"}
  | {status: "wrongCode"; attemptsRemaining: number};

/**
 * Classifies a stored document that holds no live grant.
 *
 * @param {VerificationCodeDocument} existing Stored verification document.
 * @param {number} nowMs Current time in epoch milliseconds.
 * @return {VerifyOutcome|null} The refusal, or null if submission may go on.
 */
function refusalForStaleDocument(
  existing: VerificationCodeDocument,
  nowMs: number,
): VerifyOutcome | null {
  if (existing.verified) {
    // Verified but the grant has lapsed: a new code is the only way on.
    return {status: "grantExpired"};
  }
  if (existing.expiresAt.toMillis() <= nowMs) {
    return {status: "codeExpired"};
  }
  if (existing.attemptsRemaining <= 0) {
    return {status: "attemptsExhausted"};
  }

  return null;
}

/**
 * Turns a refused outcome into the error the client receives.
 *
 * @param {VerifyOutcome} outcome Refused outcome.
 * @return {HttpsError} Error to throw.
 */
function errorForOutcome(outcome: VerifyOutcome): HttpsError {
  switch (outcome.status) {
  case "noCode":
    return new HttpsError("not-found", NO_CODE_MESSAGE);
  case "grantExpired":
    return new HttpsError("failed-precondition", GRANT_EXPIRED_MESSAGE);
  case "codeExpired":
    return new HttpsError("failed-precondition", CODE_EXPIRED_MESSAGE);
  case "attemptsExhausted":
    return new HttpsError("resource-exhausted", ATTEMPTS_EXHAUSTED_MESSAGE);
  default:
    // `details` reaches the client verbatim, which is what lets the screen
    // say how many tries are left instead of only "wrong code".
    return new HttpsError("invalid-argument", WRONG_CODE_MESSAGE, {
      attemptsRemaining: outcome.status === "wrongCode" ?
        outcome.attemptsRemaining :
        0,
    });
  }
}

/**
 * Handles `verifyEmailCode`.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {EmailVerificationDependencies} deps Handler dependencies.
 * @return {Promise<VerificationResult>} The granted verification.
 */
export async function handleVerifyEmailCode(
  request: CallableRequest<unknown>,
  deps: EmailVerificationDependencies = defaultDeps,
): Promise<VerificationResult> {
  const email = parseEmail(request.data);
  const code = (request.data as {code?: unknown} | null)?.code;
  if (!isWellFormedVerificationCode(code)) {
    throw new HttpsError("invalid-argument", INVALID_CODE_FORMAT_MESSAGE);
  }

  const reference = deps.verificationDocument(email);
  const outcome = await deps.runTransaction<VerifyOutcome>(
    async (transaction) => {
      const snapshot = await transaction.get(reference);
      const existing = snapshot.data();
      if (!existing) {
        return {status: "noCode"};
      }

      const now = deps.now();
      const nowMs = now.toMillis();
      const grantValid = isVerificationGrantValid(existing, nowMs);
      if (!grantValid) {
        const refusal = refusalForStaleDocument(existing, nowMs);
        if (refusal) {
          return refusal;
        }
      }

      if (!codesMatch(existing.code, code)) {
        const attemptsRemaining = Math.max(0, existing.attemptsRemaining - 1);
        transaction.update(reference, {attemptsRemaining, updatedAt: now});
        return {status: "wrongCode", attemptsRemaining};
      }

      // Re-submitting the correct code inside a live grant is a no-op rather
      // than a second grant, so a double-click cannot extend the window.
      if (grantValid && existing.verifiedUntil) {
        return {
          status: "verified",
          verifiedUntil: existing.verifiedUntil.toMillis(),
        };
      }

      const verifiedUntil = Timestamp.fromMillis(
        nowMs + VERIFICATION_GRANT_TTL_MS,
      );
      transaction.update(reference, {
        updatedAt: now,
        verified: true,
        verifiedUntil,
      });
      return {status: "verified", verifiedUntil: verifiedUntil.toMillis()};
    },
  );

  if (outcome.status !== "verified") {
    throw errorForOutcome(outcome);
  }

  return {verified: true, verifiedUntil: outcome.verifiedUntil};
}

/**
 * Fails unless the address holds a live verification grant.
 *
 * Called by `registration.ts` before any account is created, which is what
 * makes step 2 unskippable: reaching the registration Callable directly
 * still requires having passed `verifyEmailCode` for that same address.
 *
 * @param {string} email Address about to be registered.
 * @param {object} deps Verification document accessor and clock.
 * @return {Promise<void>} Resolves when a live grant exists.
 */
export async function assertEmailVerified(
  email: string,
  deps: Pick<
    EmailVerificationDependencies, "verificationDocument" | "now"
  > = defaultDeps,
): Promise<void> {
  const normalised = normaliseVerificationEmail(email);
  const snapshot = await deps.verificationDocument(normalised).get();
  const existing = snapshot.data();
  if (!existing ||
      !isVerificationGrantValid(existing, deps.now().toMillis())) {
    throw new HttpsError("failed-precondition", EMAIL_NOT_VERIFIED_MESSAGE);
  }
}

/**
 * Drops the verification document once its grant has been spent.
 *
 * Best effort: a stale document only costs storage, whereas failing the
 * registration that already created the account would leave the caller with
 * an account they were told they do not have.
 *
 * @param {string} email Address that was just registered.
 * @param {object} deps Verification document accessor.
 * @return {Promise<void>} Always resolves.
 */
export async function consumeEmailVerification(
  email: string,
  deps: Pick<
    EmailVerificationDependencies, "verificationDocument"
  > = defaultDeps,
): Promise<void> {
  try {
    await deps.verificationDocument(
      normaliseVerificationEmail(email),
    ).delete();
  } catch (error: unknown) {
    logger.warn("Failed to delete a spent verification code.", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

export const startEmailVerification = onCall((request) =>
  handleStartEmailVerification(request),
);

export const resendEmailVerificationCode = onCall((request) =>
  handleResendEmailVerificationCode(request),
);

export const verifyEmailCode = onCall((request) =>
  handleVerifyEmailCode(request),
);
