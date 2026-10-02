import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  canRestoreAccount,
  canTransitionToPurging,
  isAllowedEmailDomain,
  isAuthTimeFresh,
  isValidEmailAddress,
  matchesDeletionAttempt,
} from "./auth-helpers.js";
import {ALLOWED_EMAIL_DOMAINS as REGISTRY_EMAIL_DOMAINS} from
  "../domain/validation.js";
import {
  ABANDONED_SIGNUP_CLEANUP_DAYS,
  ALLOWED_EMAIL_DOMAINS,
  AUTH_TIME_FRESHNESS_SECONDS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  PURGE_DELAY_SECONDS,
  PURGING_RETRY_DELAY_SECONDS,
  SESSION_COOKIE_EXPIRES_IN_MS,
  USER_STATUS,
} from "./constants.js";
import type {TimestampLike} from "./types.js";

const NOW_SECONDS = 10_000;
const NOW_MILLISECONDS = NOW_SECONDS * 1_000;

/**
 * Builds the minimal timestamp interface used by transition predicates.
 *
 * @param {number} milliseconds Timestamp value.
 * @return {TimestampLike} Test timestamp.
 */
function timestamp(milliseconds: number): TimestampLike {
  return {toMillis: () => milliseconds};
}

describe("email address validation", () => {
  it("accepts common valid email address shapes", () => {
    assert.equal(isValidEmailAddress("member@example.com"), true);
    assert.equal(isValidEmailAddress("first.last+tag@example.com"), true);
  });

  it("rejects missing components and whitespace", () => {
    assert.equal(isValidEmailAddress(""), false);
    assert.equal(isValidEmailAddress("member.example.com"), false);
    assert.equal(isValidEmailAddress("member@example"), false);
    assert.equal(isValidEmailAddress("member @example.com"), false);
    assert.equal(isValidEmailAddress("member@example.com "), false);
  });
});

describe("allowed e-mail domain validation", () => {
  it("accepts every spec 3.4 domain, case-insensitively", () => {
    assert.equal(isAllowedEmailDomain("member@example.com"), true);
    assert.equal(isAllowedEmailDomain("member@example.net"), true);
    assert.equal(isAllowedEmailDomain("member@example.org"), true);
    assert.equal(isAllowedEmailDomain("member@ExAmPlE.CoM"), true);
    assert.equal(isAllowedEmailDomain("member@EXAMPLE.NET"), true);
  });

  it("stays in step with the registry-facing list in domain/validation", () => {
    // The same spec 3.4 constraint is declared twice, once per layer. They
    // drifted apart once already (auth accepted only example.com while the
    // registries and the UI accepted all three), which registration surfaced
    // as an opaque 400, so pin them together here.
    assert.deepEqual(
      [...ALLOWED_EMAIL_DOMAINS],
      [...REGISTRY_EMAIL_DOMAINS],
    );
  });

  it("rejects a domain outside the list", () => {
    assert.equal(isAllowedEmailDomain("member@example.jp"), false);
    assert.equal(isAllowedEmailDomain("member@gmail.com"), false);
  });

  it("rejects malformed, subdomain, and lookalike addresses", () => {
    assert.equal(isAllowedEmailDomain("member@sub.example.com"), false);
    assert.equal(isAllowedEmailDomain("member@example.com.evil.test"), false);
    assert.equal(isAllowedEmailDomain("member@@example.com"), false);
    assert.equal(isAllowedEmailDomain("@example.com"), false);
    assert.equal(isAllowedEmailDomain("member@example.com."), false);
    assert.equal(isAllowedEmailDomain("member@"), false);
    assert.equal(isAllowedEmailDomain("member.example.com"), false);
  });
});

describe("auth_time freshness", () => {
  it("accepts the exact provisional five-minute boundary", () => {
    assert.equal(
      isAuthTimeFresh(
        NOW_SECONDS - AUTH_TIME_FRESHNESS_SECONDS,
        NOW_SECONDS,
      ),
      true,
    );
  });

  it("rejects a token just beyond the freshness boundary", () => {
    assert.equal(
      isAuthTimeFresh(
        NOW_SECONDS - AUTH_TIME_FRESHNESS_SECONDS - 0.001,
        NOW_SECONDS,
      ),
      false,
    );
    assert.equal(isAuthTimeFresh("not-a-time", NOW_SECONDS), false);
    assert.equal(isAuthTimeFresh(undefined, NOW_SECONDS), false);
    assert.equal(isAuthTimeFresh(Number.POSITIVE_INFINITY, NOW_SECONDS), false);
  });

  it("tolerates auth_time slightly ahead of our clock (clock skew)", () => {
    assert.equal(
      isAuthTimeFresh(
        NOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS,
        NOW_SECONDS,
      ),
      true,
    );
  });

  it("rejects auth_time far enough in the future to not be clock skew", () => {
    assert.equal(
      isAuthTimeFresh(
        NOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 1,
        NOW_SECONDS,
      ),
      false,
    );
    assert.equal(
      isAuthTimeFresh(NOW_SECONDS + AUTH_TIME_FRESHNESS_SECONDS, NOW_SECONDS),
      false,
    );
  });
});

describe("account lifecycle transition guards", () => {
  it("allows only pending_deletion to transition to purging", () => {
    assert.equal(
      canTransitionToPurging(USER_STATUS.PENDING_DELETION),
      true,
    );
    assert.equal(canTransitionToPurging(USER_STATUS.ACTIVE), false);
    assert.equal(canTransitionToPurging(USER_STATUS.PURGING), false);
    assert.equal(canTransitionToPurging(undefined), false);
  });

  it("allows restore only before the purge deadline", () => {
    const now = timestamp(NOW_MILLISECONDS);
    const futureDeadline = timestamp(NOW_MILLISECONDS + 1);
    const currentDeadline = timestamp(NOW_MILLISECONDS);

    assert.equal(
      canRestoreAccount(
        USER_STATUS.PENDING_DELETION,
        futureDeadline,
        now,
      ),
      true,
    );
    assert.equal(
      canRestoreAccount(
        USER_STATUS.PENDING_DELETION,
        currentDeadline,
        now,
      ),
      false,
    );
    assert.equal(
      canRestoreAccount(USER_STATUS.ACTIVE, futureDeadline, now),
      false,
    );
    assert.equal(
      canRestoreAccount(USER_STATUS.PURGING, futureDeadline, now),
      false,
    );
    assert.equal(
      canRestoreAccount(USER_STATUS.PENDING_DELETION, null, now),
      false,
    );
    assert.equal(
      canRestoreAccount(USER_STATUS.PENDING_DELETION, undefined, now),
      false,
    );
  });

  it("matches the pending deletion attempt with exact timestamps", () => {
    const requestedAt = timestamp(NOW_MILLISECONDS);
    const purgeAt = timestamp(NOW_MILLISECONDS + 1);

    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.PENDING_DELETION,
        timestamp(NOW_MILLISECONDS),
        timestamp(NOW_MILLISECONDS + 1),
        requestedAt,
        purgeAt,
      ),
      true,
    );
    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.PENDING_DELETION,
        timestamp(NOW_MILLISECONDS - 1),
        purgeAt,
        requestedAt,
        purgeAt,
      ),
      false,
    );
    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.PENDING_DELETION,
        requestedAt,
        timestamp(NOW_MILLISECONDS + 2),
        requestedAt,
        purgeAt,
      ),
      false,
    );
  });

  it("rejects a matching deletion generation outside pending_deletion", () => {
    const requestedAt = timestamp(NOW_MILLISECONDS);
    const purgeAt = timestamp(NOW_MILLISECONDS + 1);

    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.ACTIVE,
        requestedAt,
        purgeAt,
        requestedAt,
        purgeAt,
      ),
      false,
    );
    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.PENDING_DELETION,
        null,
        purgeAt,
        requestedAt,
        purgeAt,
      ),
      false,
    );
    assert.equal(
      matchesDeletionAttempt(
        USER_STATUS.PENDING_DELETION,
        requestedAt,
        undefined,
        requestedAt,
        purgeAt,
      ),
      false,
    );
  });
});

describe("lifecycle transition guards are profile-shape agnostic", () => {
  // `UserDocument` becomes a status-discriminated union with a nested
  // `profile` (null only for pending_additional_info) as part of the
  // full-profile feature. These guards take only primitives extracted from
  // it (status/timestamps), so they must behave identically whether the
  // source record's `profile` was null or fully populated.
  it("evaluates canTransitionToPurging the same regardless of the source " +
    "record's profile completeness", () => {
    const fromMinimalPendingAdditionalInfoRecord = {
      profile: null,
      status: USER_STATUS.PENDING_DELETION,
    };
    const fromFullActiveRecord = {
      profile: {accountType: "individual", name: "Integration User"},
      status: USER_STATUS.PENDING_DELETION,
    };

    assert.equal(
      canTransitionToPurging(fromMinimalPendingAdditionalInfoRecord.status),
      canTransitionToPurging(fromFullActiveRecord.status),
    );
    assert.equal(
      canTransitionToPurging(fromFullActiveRecord.status),
      true,
    );
  });

  it("evaluates canRestoreAccount and matchesDeletionAttempt the same " +
    "regardless of the source record's profile completeness", () => {
    const requestedAt = timestamp(NOW_MILLISECONDS);
    const purgeAt = timestamp(NOW_MILLISECONDS + 1);
    const now = timestamp(NOW_MILLISECONDS);

    const minimalRestore = canRestoreAccount(
      USER_STATUS.PENDING_DELETION,
      purgeAt,
      now,
    );
    const fullRestore = canRestoreAccount(
      USER_STATUS.PENDING_DELETION,
      purgeAt,
      now,
    );
    assert.equal(minimalRestore, fullRestore);
    assert.equal(fullRestore, true);

    const minimalMatch = matchesDeletionAttempt(
      USER_STATUS.PENDING_DELETION,
      requestedAt,
      purgeAt,
      requestedAt,
      purgeAt,
    );
    const fullMatch = matchesDeletionAttempt(
      USER_STATUS.PENDING_DELETION,
      requestedAt,
      purgeAt,
      requestedAt,
      purgeAt,
    );
    assert.equal(minimalMatch, fullMatch);
    assert.equal(fullMatch, true);
  });
});

describe("authentication contract constants", () => {
  it(
    "keeps session and lifecycle durations aligned with the API contract",
    () => {
      assert.equal(SESSION_COOKIE_EXPIRES_IN_MS, 432_000_000);
      assert.equal(AUTH_TIME_FRESHNESS_SECONDS, 300);
      assert.equal(PURGE_DELAY_SECONDS, 2_592_000);
      assert.equal(ABANDONED_SIGNUP_CLEANUP_DAYS, 7);
      assert.equal(PURGING_RETRY_DELAY_SECONDS, 3_600);
    },
  );
});
