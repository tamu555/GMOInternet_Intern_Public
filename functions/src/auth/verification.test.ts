/**
 * Callable-contract tests for the three e-mail-verification handlers,
 * following `registration.test.ts`'s `handle*`-extraction pattern: the
 * Firestore transaction is substituted by an in-memory fake, so these run
 * without a live Firestore connection.
 *
 * The fake deliberately keeps a real transaction's most important property:
 * writes staged by a callback that ends up throwing are discarded. That is
 * what pins the wrong-code branch to returning its refusal instead of
 * throwing, which would roll the attempt decrement back and hand the caller
 * unlimited attempts.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {Auth} from "firebase-admin/auth";
import type {DocumentReference, Transaction} from "firebase-admin/firestore";
import {Timestamp} from "firebase-admin/firestore";
import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_GRANT_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_RESEND_INTERVAL_MS,
} from "./constants.js";
import {
  handleResendEmailVerificationCode,
  handleStartEmailVerification,
  handleVerifyEmailCode,
} from "./verification.js";
import type {EmailVerificationDependencies} from "./verification.js";
import type {UserDocument, VerificationCodeDocument} from "./types.js";

const NOW_MS = 1_700_000_000_000;
const EMAIL = "member@example.com";
const ISSUED_CODE = "246810";

/**
 * Builds the request shape received after Callable authentication.
 *
 * @param {unknown} data Callable request data.
 * @return {CallableRequest<unknown>} Synthetic Callable request.
 */
function callableRequest(data: unknown): CallableRequest<unknown> {
  return {
    acceptsStreaming: false,
    data,
    rawRequest: {},
  } as CallableRequest<unknown>;
}

/**
 * Asserts that a Callable rejects with the given HttpsError code.
 *
 * @param {Function} action Callable invocation.
 * @param {string} expectedCode Expected Firebase Functions error code.
 * @return {Promise<HttpsError>} The rejected error, for further inspection.
 */
async function assertRejectsWithCode(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<HttpsError> {
  let captured: unknown;
  await assert.rejects(action, (error: unknown) => {
    captured = error;
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expectedCode);
    return true;
  });
  return captured as HttpsError;
}

interface ExistingAuthUser {
  uid: string;
  email: string;
}

interface StoreOptions {
  stored?: VerificationCodeDocument | null;
  nowMs?: number;
  nextCode?: string;
  /** `undefined` (the default) means no Auth account holds the address. */
  existingAuthUser?: ExistingAuthUser;
  /** Status on `users/{uid}` for `existingAuthUser`, if any. */
  existingUserStatus?: UserDocument["status"];
  /** Simulates `getUserByEmail` failing for a reason other than not-found. */
  authLookupError?: unknown;
}

/**
 * Builds dependencies backed by a one-document in-memory store.
 *
 * @param {StoreOptions} options Fixture behavior.
 * @return {object} Dependencies plus a reader for the stored document.
 */
function buildDeps(options: StoreOptions = {}): {
  deps: EmailVerificationDependencies;
  read: () => VerificationCodeDocument | undefined;
  requestedEmails: string[];
  getUserByEmailCalls: string[];
} {
  let committed = options.stored ?? undefined;
  const requestedEmails: string[] = [];
  const getUserByEmailCalls: string[] = [];
  const nowMs = options.nowMs ?? NOW_MS;

  const runTransaction = async <T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
  ): Promise<T> => {
    let staged = committed;
    const transaction = {
      get: async () => ({data: () => staged}),
      set: (_reference: unknown, document: VerificationCodeDocument) => {
        staged = document;
      },
      update: (
        _reference: unknown,
        patch: Partial<VerificationCodeDocument>,
      ) => {
        assert.ok(staged, "update before set");
        staged = {...staged, ...patch};
      },
    };
    // A throw leaves `committed` untouched, exactly as a rolled-back
    // Firestore transaction would.
    const result = await updateFunction(
      transaction as unknown as Transaction,
    );
    committed = staged;
    return result;
  };

  const fakeAuthApi = {
    getUserByEmail: async (email: string) => {
      getUserByEmailCalls.push(email);
      if (options.authLookupError) {
        throw options.authLookupError;
      }
      if (!options.existingAuthUser) {
        throw Object.assign(new Error("auth/user-not-found"), {
          code: "auth/user-not-found",
        });
      }
      return options.existingAuthUser;
    },
  };

  return {
    deps: {
      auth: () => fakeAuthApi as unknown as Auth,
      generateCode: () => options.nextCode ?? ISSUED_CODE,
      now: () => Timestamp.fromMillis(nowMs),
      runTransaction,
      userDocument: () => ({
        get: async () => ({
          data: () => options.existingUserStatus === undefined ?
            undefined :
            ({status: options.existingUserStatus} as UserDocument),
        }),
      } as unknown as DocumentReference<UserDocument>),
      verificationDocument: (email: string) => {
        requestedEmails.push(email);
        return {} as DocumentReference<VerificationCodeDocument>;
      },
    },
    getUserByEmailCalls,
    read: () => committed,
    requestedEmails,
  };
}

/**
 * Builds a stored, freshly issued and unverified document.
 *
 * @param {Partial<VerificationCodeDocument>} overrides Fields to override.
 * @return {VerificationCodeDocument} Stored verification document.
 */
function storedCode(
  overrides: Partial<VerificationCodeDocument> = {},
): VerificationCodeDocument {
  return {
    attemptsRemaining: VERIFICATION_MAX_ATTEMPTS,
    code: ISSUED_CODE,
    createdAt: Timestamp.fromMillis(NOW_MS),
    email: EMAIL,
    expiresAt: Timestamp.fromMillis(NOW_MS + VERIFICATION_CODE_TTL_MS),
    resendAvailableAt: Timestamp.fromMillis(
      NOW_MS + VERIFICATION_RESEND_INTERVAL_MS,
    ),
    updatedAt: Timestamp.fromMillis(NOW_MS),
    verified: false,
    verifiedUntil: null,
    ...overrides,
  };
}

describe("startEmailVerification: address validation", () => {
  it("rejects a non-string, malformed or missing address", async () => {
    const {deps} = buildDeps();
    for (const data of [null, {}, {email: 42}, {email: "not-an-address"}]) {
      await assertRejectsWithCode(
        () => handleStartEmailVerification(callableRequest(data), deps),
        "invalid-argument",
      );
    }
  });

  it("rejects a domain outside the spec 3.4 allow-list, before any Auth " +
    "lookup", async () => {
    const {deps, read, getUserByEmailCalls} = buildDeps({stored: null});
    await assertRejectsWithCode(
      () => handleStartEmailVerification(
        callableRequest({email: "member@gmail.com"}),
        deps,
      ),
      "invalid-argument",
    );
    assert.equal(read(), undefined, "no code may be issued for it");
    assert.deepEqual(
      getUserByEmailCalls,
      [],
      "the domain allow-list must run before any Auth account lookup",
    );
  });

  it("accepts every allowed domain, case-insensitively", async () => {
    for (const email of [
      "member@example.com",
      "member@EXAMPLE.NET",
      "  Member@Example.Org  ",
    ]) {
      const {deps, requestedEmails} = buildDeps({stored: null});
      const status = await handleStartEmailVerification(
        callableRequest({email}),
        deps,
      );
      // The address is normalised before it ever becomes a document id, so
      // the client's own lower-cased lookup always finds the document.
      assert.equal(status.email, email.trim().toLowerCase());
      assert.deepEqual(requestedEmails, [email.trim().toLowerCase()]);
    }
  });
});

describe("startEmailVerification: issuing", () => {
  it("issues a fresh code and never echoes it back to the caller",
    async () => {
      const {deps, read} = buildDeps({stored: null});

      const status = await handleStartEmailVerification(
        callableRequest({email: EMAIL}),
        deps,
      );

      assert.equal(read()?.code, ISSUED_CODE);
      assert.equal(read()?.verified, false);
      assert.equal(status.attemptsRemaining, VERIFICATION_MAX_ATTEMPTS);
      assert.equal(status.expiresAt, NOW_MS + VERIFICATION_CODE_TTL_MS);
      assert.equal(
        status.resendAvailableAt,
        NOW_MS + VERIFICATION_RESEND_INTERVAL_MS,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(status, "code"),
        false,
        "the code travels only through the Firestore read the rules allow",
      );
    });

  it("is idempotent: re-submitting step 1 keeps the live code", async () => {
    const {deps, read} = buildDeps({
      nextCode: "999999",
      stored: storedCode(),
    });

    const status = await handleStartEmailVerification(
      callableRequest({email: EMAIL}),
      deps,
    );

    assert.equal(read()?.code, ISSUED_CODE, "the inbox code must survive");
    assert.equal(
      status.resendAvailableAt,
      read()?.resendAvailableAt.toMillis(),
    );
  });

  it("does not revoke a verification the visitor already passed",
    async () => {
      const {deps, read} = buildDeps({
        nextCode: "999999",
        stored: storedCode({
          verified: true,
          verifiedUntil: Timestamp.fromMillis(
            NOW_MS + VERIFICATION_GRANT_TTL_MS,
          ),
        }),
      });

      const status = await handleStartEmailVerification(
        callableRequest({email: EMAIL}),
        deps,
      );

      assert.equal(status.verified, true);
      assert.equal(read()?.verified, true);
      assert.equal(read()?.code, ISSUED_CODE);
    });

  it("issues a new code once the old one expired", async () => {
    const {deps, read} = buildDeps({
      nextCode: "999999",
      stored: storedCode({expiresAt: Timestamp.fromMillis(NOW_MS)}),
    });

    await handleStartEmailVerification(callableRequest({email: EMAIL}), deps);

    assert.equal(read()?.code, "999999");
    assert.equal(read()?.attemptsRemaining, VERIFICATION_MAX_ATTEMPTS);
    // createdAt records the first attempt for this address, not the reissue.
    assert.equal(read()?.createdAt.toMillis(), NOW_MS);
  });
});

describe("startEmailVerification: existing account (spec 4.1)", () => {
  it("rejects an address with an active account, without issuing a code " +
    "or writing verificationCodes/{email}", async () => {
    const {deps, read} = buildDeps({
      existingAuthUser: {email: EMAIL, uid: "existing-uid"},
      existingUserStatus: "active",
      stored: null,
    });

    const error = await assertRejectsWithCode(
      () => handleStartEmailVerification(callableRequest({email: EMAIL}), deps),
      "already-exists",
    );

    assert.equal(
      error.message,
      "An account with this email already exists. Sign in with Google if " +
        "that was the original sign-in method.",
    );
    assert.equal(read(), undefined, "no OTP document may be written");
  });

  it("rejects an address pending deletion with the deletion-in-progress " +
    "message, without issuing a code", async () => {
    const {deps, read} = buildDeps({
      existingAuthUser: {email: EMAIL, uid: "existing-uid"},
      existingUserStatus: "pending_deletion",
      stored: null,
    });

    const error = await assertRejectsWithCode(
      () => handleStartEmailVerification(callableRequest({email: EMAIL}), deps),
      "already-exists",
    );

    assert.equal(error.message, "The account is being deleted.");
    assert.equal(read(), undefined, "no OTP document may be written");
  });

  it("rejects an address currently purging with the deletion-in-progress " +
    "message", async () => {
    const {deps} = buildDeps({
      existingAuthUser: {email: EMAIL, uid: "existing-uid"},
      existingUserStatus: "purging",
      stored: null,
    });

    const error = await assertRejectsWithCode(
      () => handleStartEmailVerification(callableRequest({email: EMAIL}), deps),
      "already-exists",
    );

    assert.equal(error.message, "The account is being deleted.");
  });

  it("issues a code as before when the address is unknown to Auth",
    async () => {
      const {deps, read, getUserByEmailCalls} = buildDeps({stored: null});

      const status = await handleStartEmailVerification(
        callableRequest({email: EMAIL}),
        deps,
      );

      assert.deepEqual(getUserByEmailCalls, [EMAIL]);
      assert.equal(status.verified, false);
      assert.equal(read()?.code, ISSUED_CODE);
    });
});

describe("resendEmailVerificationCode", () => {
  it("refuses a resend inside the cooldown without touching the code",
    async () => {
      const {deps, read} = buildDeps({
        nextCode: "999999",
        stored: storedCode(),
      });

      await assertRejectsWithCode(
        () => handleResendEmailVerificationCode(
          callableRequest({email: EMAIL}),
          deps,
        ),
        "resource-exhausted",
      );

      assert.equal(read()?.code, ISSUED_CODE);
    });

  it("mints a new code and resets the attempts once the cooldown elapsed",
    async () => {
      const {deps, read} = buildDeps({
        nextCode: "999999",
        nowMs: NOW_MS + VERIFICATION_RESEND_INTERVAL_MS,
        stored: storedCode({attemptsRemaining: 1}),
      });

      const status = await handleResendEmailVerificationCode(
        callableRequest({email: EMAIL}),
        deps,
      );

      assert.equal(read()?.code, "999999");
      assert.equal(status.attemptsRemaining, VERIFICATION_MAX_ATTEMPTS);
    });

  it("issues the first code when none exists yet", async () => {
    const {deps, read} = buildDeps({stored: null});

    await handleResendEmailVerificationCode(
      callableRequest({email: EMAIL}),
      deps,
    );

    assert.equal(read()?.code, ISSUED_CODE);
  });
});

describe("verifyEmailCode", () => {
  it("rejects a malformed code before reading anything", async () => {
    const {deps} = buildDeps({stored: storedCode()});
    for (const code of ["12345", "abcdef", "", 246810, null]) {
      await assertRejectsWithCode(
        () => handleVerifyEmailCode(
          callableRequest({code, email: EMAIL}),
          deps,
        ),
        "invalid-argument",
      );
    }
  });

  it("grants a verification for the right code", async () => {
    const {deps, read} = buildDeps({stored: storedCode()});

    const result = await handleVerifyEmailCode(
      callableRequest({code: ISSUED_CODE, email: EMAIL}),
      deps,
    );

    assert.equal(result.verified, true);
    assert.equal(result.verifiedUntil, NOW_MS + VERIFICATION_GRANT_TTL_MS);
    assert.equal(read()?.verified, true);
  });

  it("burns one attempt per wrong code and reports what is left",
    async () => {
      const {deps, read} = buildDeps({stored: storedCode()});

      const error = await assertRejectsWithCode(
        () => handleVerifyEmailCode(
          callableRequest({code: "000000", email: EMAIL}),
          deps,
        ),
        "invalid-argument",
      );

      // The decrement must survive the refusal - a transaction that threw
      // instead of returning would have rolled it back.
      assert.equal(read()?.attemptsRemaining, VERIFICATION_MAX_ATTEMPTS - 1);
      assert.deepEqual(error.details, {
        attemptsRemaining: VERIFICATION_MAX_ATTEMPTS - 1,
      });
      assert.equal(read()?.verified, false);
    });

  it("stops accepting submissions once the attempts are exhausted",
    async () => {
      const {deps, read} = buildDeps({stored: storedCode({
        attemptsRemaining: 0,
      })});

      await assertRejectsWithCode(
        () => handleVerifyEmailCode(
          // Even the correct code: the burned counter closes the code.
          callableRequest({code: ISSUED_CODE, email: EMAIL}),
          deps,
        ),
        "resource-exhausted",
      );

      assert.equal(read()?.verified, false);
    });

  it("refuses an expired code", async () => {
    const {deps} = buildDeps({
      stored: storedCode({expiresAt: Timestamp.fromMillis(NOW_MS)}),
    });

    await assertRejectsWithCode(
      () => handleVerifyEmailCode(
        callableRequest({code: ISSUED_CODE, email: EMAIL}),
        deps,
      ),
      "failed-precondition",
    );
  });

  it("refuses when no code was ever issued", async () => {
    const {deps} = buildDeps({stored: null});

    await assertRejectsWithCode(
      () => handleVerifyEmailCode(
        callableRequest({code: ISSUED_CODE, email: EMAIL}),
        deps,
      ),
      "not-found",
    );
  });

  it("refuses once the granted window has lapsed", async () => {
    const {deps} = buildDeps({
      stored: storedCode({
        verified: true,
        verifiedUntil: Timestamp.fromMillis(NOW_MS),
      }),
    });

    await assertRejectsWithCode(
      () => handleVerifyEmailCode(
        callableRequest({code: ISSUED_CODE, email: EMAIL}),
        deps,
      ),
      "failed-precondition",
    );
  });

  it("re-verifying inside a live grant does not extend it", async () => {
    const verifiedUntil = NOW_MS + 1_000;
    const {deps, read} = buildDeps({
      stored: storedCode({
        verified: true,
        verifiedUntil: Timestamp.fromMillis(verifiedUntil),
      }),
    });

    const result = await handleVerifyEmailCode(
      callableRequest({code: ISSUED_CODE, email: EMAIL}),
      deps,
    );

    assert.equal(result.verifiedUntil, verifiedUntil);
    assert.equal(read()?.verifiedUntil?.toMillis(), verifiedUntil);
  });
});
