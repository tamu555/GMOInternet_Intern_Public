import {
  ALLOWED_EMAIL_DOMAINS,
  AUTH_TIME_FRESHNESS_SECONDS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  USER_STATUS,
} from "./constants.js";
import type {TimestampLike, UserStatus} from "./types.js";

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks whether an email address has a minimally valid structure.
 *
 * @param {string} email Email address to validate.
 * @return {boolean} Whether the address has a valid structure.
 */
export function isValidEmailAddress(email: string): boolean {
  return EMAIL_ADDRESS_PATTERN.test(email);
}

/**
 * Checks whether an email address belongs to one of the allowed domains.
 *
 * @param {string} email Email address to inspect.
 * @return {boolean} Whether the domain is exactly one of ALLOWED_EMAIL_DOMAINS.
 */
export function isAllowedEmailDomain(email: string): boolean {
  const emailParts = email.split("@");
  if (emailParts.length !== 2 || emailParts[0].length === 0) {
    return false;
  }

  const domain = emailParts[1].toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((allowed) => allowed === domain);
}

/**
 * Checks whether an Auth token represents a recent reauthentication.
 *
 * @param {unknown} authTime Firebase auth_time claim in UNIX seconds.
 * @param {number} nowSeconds Current time in UNIX seconds.
 * @return {boolean} Whether auth_time is inside the freshness window.
 */
export function isAuthTimeFresh(
  authTime: unknown,
  nowSeconds = Date.now() / 1_000,
): boolean {
  const parsedAuthTime = Number(authTime);
  if (!Number.isFinite(parsedAuthTime)) {
    return false;
  }

  const ageSeconds = nowSeconds - parsedAuthTime;

  // A auth_time far enough ahead of our clock to exceed the skew tolerance
  // is not a legitimately fresh reauthentication; reject it rather than
  // treating a negative age as "very fresh".
  if (ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) {
    return false;
  }

  // The five-minute limit is the provisional default in auth.md.
  return ageSeconds <= AUTH_TIME_FRESHNESS_SECONDS;
}

/**
 * Checks the guarded pending-deletion to purging transition.
 *
 * @param {UserStatus|undefined} status Current account status.
 * @return {boolean} Whether the account may transition to purging.
 */
export function canTransitionToPurging(
  status: UserStatus | undefined,
): boolean {
  return status === USER_STATUS.PENDING_DELETION;
}

/**
 * Checks the guarded pending-deletion to active restoration transition.
 *
 * @param {UserStatus|undefined} status Current account status.
 * @param {TimestampLike|null|undefined} scheduledPurgeAt Purge deadline.
 * @param {TimestampLike} now Current time.
 * @return {boolean} Whether the account may be restored.
 */
export function canRestoreAccount(
  status: UserStatus | undefined,
  scheduledPurgeAt: TimestampLike | null | undefined,
  now: TimestampLike,
): boolean {
  if (status !== USER_STATUS.PENDING_DELETION || !scheduledPurgeAt) {
    return false;
  }

  return scheduledPurgeAt.toMillis() > now.toMillis();
}

/**
 * Checks whether a pending-deletion record belongs to one deletion attempt.
 *
 * @param {UserStatus|undefined} status Current account status.
 * @param {TimestampLike|null|undefined} deletionRequestedAt Stored request
 * time.
 * @param {TimestampLike|null|undefined} scheduledPurgeAt Stored purge deadline.
 * @param {TimestampLike} expectedDeletionRequestedAt Expected request time.
 * @param {TimestampLike} expectedScheduledPurgeAt Expected purge deadline.
 * @return {boolean} Whether the stored deletion generation exactly matches.
 */
export function matchesDeletionAttempt(
  status: UserStatus | undefined,
  deletionRequestedAt: TimestampLike | null | undefined,
  scheduledPurgeAt: TimestampLike | null | undefined,
  expectedDeletionRequestedAt: TimestampLike,
  expectedScheduledPurgeAt: TimestampLike,
): boolean {
  if (
    status !== USER_STATUS.PENDING_DELETION ||
    !deletionRequestedAt ||
    !scheduledPurgeAt
  ) {
    return false;
  }

  return (
    deletionRequestedAt.toMillis() === expectedDeletionRequestedAt.toMillis() &&
    scheduledPurgeAt.toMillis() === expectedScheduledPurgeAt.toMillis()
  );
}
