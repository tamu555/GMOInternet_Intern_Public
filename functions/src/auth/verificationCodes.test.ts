/**
 * Unit tests for the pure verification-code helpers. No Firestore, no
 * Callable wrapper - the Firestore/transaction layer is covered by
 * `verification.integration.test.ts`.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_GRANT_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_RESEND_INTERVAL_MS,
} from "./constants.js";
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
import type {TimestampLike, VerificationCodeState} from "./types.js";

const NOW_MS = 1_700_000_000_000;

/**
 * Builds the minimal timestamp interface the predicates consume.
 *
 * @param {number} milliseconds Timestamp value.
 * @return {TimestampLike} Test timestamp.
 */
function timestamp(milliseconds: number): TimestampLike {
  return {toMillis: () => milliseconds};
}

/**
 * Builds a freshly issued, unverified code state.
 *
 * @param {Partial<VerificationCodeState>} overrides Fields to override.
 * @return {VerificationCodeState} Test state.
 */
function freshState(
  overrides: Partial<VerificationCodeState> = {},
): VerificationCodeState {
  return {
    attemptsRemaining: VERIFICATION_MAX_ATTEMPTS,
    code: "012345",
    expiresAt: timestamp(NOW_MS + VERIFICATION_CODE_TTL_MS),
    resendAvailableAt: timestamp(NOW_MS + VERIFICATION_RESEND_INTERVAL_MS),
    verified: false,
    verifiedUntil: null,
    ...overrides,
  };
}

describe("normaliseVerificationEmail", () => {
  it("trims and lower-cases so both sides agree on the document id", () => {
    assert.equal(
      normaliseVerificationEmail("  Member@Example.COM "),
      "member@example.com",
    );
  });

  it("leaves an already normalised address untouched", () => {
    assert.equal(
      normaliseVerificationEmail("member@example.com"),
      "member@example.com",
    );
  });
});

describe("isSafeVerificationDocumentId", () => {
  it("accepts an ordinary normalised address", () => {
    assert.equal(isSafeVerificationDocumentId("member@example.com"), true);
    assert.equal(
      isSafeVerificationDocumentId("first.last+tag@example.com"),
      true,
    );
  });

  it("rejects a slash, which would silently become a path segment", () => {
    assert.equal(isSafeVerificationDocumentId("a/b@example.com"), false);
  });

  it("rejects empty, dot-only and Firestore-reserved ids", () => {
    assert.equal(isSafeVerificationDocumentId(""), false);
    assert.equal(isSafeVerificationDocumentId("."), false);
    assert.equal(isSafeVerificationDocumentId(".."), false);
    assert.equal(isSafeVerificationDocumentId("__name__"), false);
  });

  it("rejects an id over Firestore's 1500-byte limit", () => {
    const local = "a".repeat(1_500);
    assert.equal(
      isSafeVerificationDocumentId(`${local}@example.com`),
      false,
    );
  });
});

describe("isWellFormedVerificationCode", () => {
  it("accepts exactly the expected number of digits", () => {
    assert.equal(isWellFormedVerificationCode("012345"), true);
  });

  it("rejects the wrong length, non-digits and non-strings", () => {
    assert.equal(isWellFormedVerificationCode("12345"), false);
    assert.equal(isWellFormedVerificationCode("1234567"), false);
    assert.equal(isWellFormedVerificationCode("12345a"), false);
    assert.equal(isWellFormedVerificationCode(" 12345"), false);
    assert.equal(isWellFormedVerificationCode(123456), false);
    assert.equal(isWellFormedVerificationCode(null), false);
  });
});

describe("generateVerificationCode", () => {
  it("always produces a zero-padded code of the declared length", () => {
    for (let round = 0; round < 500; round += 1) {
      const code = generateVerificationCode();
      assert.equal(code.length, VERIFICATION_CODE_LENGTH);
      assert.equal(isWellFormedVerificationCode(code), true);
    }
  });

  it("does not return the same code every time", () => {
    const codes = new Set(
      Array.from({length: 50}, () => generateVerificationCode()),
    );
    assert.ok(codes.size > 1, "expected more than one distinct code");
  });
});

describe("codesMatch", () => {
  it("matches identical codes and rejects everything else", () => {
    assert.equal(codesMatch("012345", "012345"), true);
    assert.equal(codesMatch("012345", "012346"), false);
    assert.equal(codesMatch("012345", "12345"), false);
    assert.equal(codesMatch("012345", ""), false);
  });
});

describe("isCodeSubmittable", () => {
  it("accepts a fresh unverified code", () => {
    assert.equal(isCodeSubmittable(freshState(), NOW_MS), true);
  });

  it("rejects an expired code, at the boundary too", () => {
    const expiresAt = timestamp(NOW_MS);
    assert.equal(isCodeSubmittable(freshState({expiresAt}), NOW_MS), false);
  });

  it("rejects a burned code", () => {
    assert.equal(
      isCodeSubmittable(freshState({attemptsRemaining: 0}), NOW_MS),
      false,
    );
  });

  it("rejects an already verified code", () => {
    assert.equal(
      isCodeSubmittable(freshState({verified: true}), NOW_MS),
      false,
    );
  });
});

describe("isResendAllowed", () => {
  it("rejects a resend inside the cooldown", () => {
    assert.equal(isResendAllowed(freshState(), NOW_MS), false);
  });

  it("allows a resend once the cooldown elapsed, boundary included", () => {
    assert.equal(
      isResendAllowed(freshState(), NOW_MS + VERIFICATION_RESEND_INTERVAL_MS),
      true,
    );
  });
});

describe("isVerificationGrantValid", () => {
  it("accepts a verified state inside its window", () => {
    const state = freshState({
      verified: true,
      verifiedUntil: timestamp(NOW_MS + VERIFICATION_GRANT_TTL_MS),
    });
    assert.equal(isVerificationGrantValid(state, NOW_MS), true);
  });

  it("rejects an unverified state even with a window set", () => {
    const state = freshState({
      verified: false,
      verifiedUntil: timestamp(NOW_MS + VERIFICATION_GRANT_TTL_MS),
    });
    assert.equal(isVerificationGrantValid(state, NOW_MS), false);
  });

  it("rejects a verified state with no window or a lapsed one", () => {
    assert.equal(
      isVerificationGrantValid(freshState({verified: true}), NOW_MS),
      false,
    );
    const lapsed = freshState({
      verified: true,
      verifiedUntil: timestamp(NOW_MS),
    });
    assert.equal(isVerificationGrantValid(lapsed, NOW_MS), false);
  });

  it("outlives the code's own expiry, which is the point of the window",
    () => {
      const state = freshState({
        expiresAt: timestamp(NOW_MS),
        verified: true,
        verifiedUntil: timestamp(NOW_MS + VERIFICATION_GRANT_TTL_MS),
      });
      assert.equal(isCodeSubmittable(state, NOW_MS), false);
      assert.equal(isVerificationGrantValid(state, NOW_MS), true);
    });
});

describe("verification constants", () => {
  it("gives a verification a longer life than the code that earned it", () => {
    assert.ok(
      VERIFICATION_GRANT_TTL_MS > VERIFICATION_CODE_TTL_MS,
      "the wizard needs more time to finish than to type the code",
    );
  });
});
