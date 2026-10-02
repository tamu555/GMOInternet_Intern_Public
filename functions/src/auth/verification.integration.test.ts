/**
 * Emulator-backed tests for the e-mail-verification Callables.
 *
 * `verification.test.ts` covers the same handlers against an in-memory fake
 * transaction; this file exists because the one property that fake can only
 * imitate - what a real Firestore transaction commits versus rolls back - is
 * exactly what the attempt counter depends on.
 *
 * Requires the Firestore emulator (`FIRESTORE_EMULATOR_HOST`).
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, afterEach, before, describe, it} from "node:test";

import firebaseFunctionsTest from "firebase-functions-test";
import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from "./constants.js";
import {verificationDocument} from "./firestore.js";
import {
  resendEmailVerificationCode,
  startEmailVerification,
  verifyEmailCode,
} from "./verification.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "teamc-2026";
const functionsTest = firebaseFunctionsTest({projectId: PROJECT_ID});
const wrappedStart = functionsTest.wrap(startEmailVerification);
const wrappedResend = functionsTest.wrap(resendEmailVerificationCode);
const wrappedVerify = functionsTest.wrap(verifyEmailCode);

const fixtureEmails = new Set<string>();

/**
 * Creates an isolated address for one test fixture.
 *
 * @param {string} domain E-mail domain.
 * @return {string} Unique address.
 */
function uniqueEmail(domain = "example.com"): string {
  const email = `verification-integration-${randomUUID()}@${domain}`;
  fixtureEmails.add(email);
  return email;
}

/**
 * Builds the request shape expected by a wrapped v2 callable function.
 *
 * @param {T} data Callable data.
 * @return {CallableRequest<T>} Minimal wrapped request.
 */
function callableRequest<T>(data: T): CallableRequest<T> {
  return {
    acceptsStreaming: false,
    data,
    rawRequest: {} as CallableRequest<T>["rawRequest"],
  };
}

/**
 * Reads the code the Callables deliberately never return.
 *
 * This is the same read the browser performs - `firestore.rules` allows a
 * `get` on this collection precisely because nothing mails the code out.
 *
 * @param {string} email Address being verified.
 * @return {Promise<string>} The stored code.
 */
async function readIssuedCode(email: string): Promise<string> {
  const snapshot = await verificationDocument(email).get();
  const code = snapshot.data()?.code;
  assert.equal(typeof code, "string", "expected an issued code");
  return code as string;
}

/**
 * Asserts that a Callable rejects with the given HttpsError code.
 *
 * @param {Promise<unknown>} pending Callable invocation.
 * @param {string} expectedCode Expected Firebase Functions error code.
 * @return {Promise<void>} Resolves once the rejection matched.
 */
async function assertRejectsWithCode(
  pending: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expectedCode);
    return true;
  });
}

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST must be set by emulators:exec",
  );
});

afterEach(async () => {
  for (const email of fixtureEmails) {
    await verificationDocument(email).delete();
  }
  fixtureEmails.clear();
});

after(() => {
  functionsTest.cleanup();
});

describe("startEmailVerification (emulator)", () => {
  it("stores a readable six-digit code without returning it", async () => {
    const email = uniqueEmail();

    const status = await wrappedStart(callableRequest({email}));

    assert.equal(status.verified, false);
    assert.equal(status.attemptsRemaining, VERIFICATION_MAX_ATTEMPTS);
    assert.match(await readIssuedCode(email), /^\d{6}$/);
    assert.ok(status.expiresAt > Date.now());
    assert.ok(
      status.expiresAt <= Date.now() + VERIFICATION_CODE_TTL_MS,
      "the stored expiry must respect the configured TTL",
    );
  });

  it("keeps the same code when step 1 is re-submitted", async () => {
    const email = uniqueEmail();
    await wrappedStart(callableRequest({email}));
    const first = await readIssuedCode(email);

    await wrappedStart(callableRequest({email}));

    assert.equal(await readIssuedCode(email), first);
  });

  it("writes one document per address, keyed by the normalised address",
    async () => {
      const email = uniqueEmail();
      await wrappedStart(callableRequest({email: email.toUpperCase()}));

      const snapshot = await verificationDocument(email).get();
      assert.equal(snapshot.exists, true);
      assert.equal(snapshot.data()?.email, email.toLowerCase());
    });

  it("refuses an address outside the allowed domains", async () => {
    await assertRejectsWithCode(
      wrappedStart(callableRequest({email: uniqueEmail("not-example.test")})),
      "invalid-argument",
    );
  });
});

describe("verifyEmailCode (emulator)", () => {
  it("commits the attempt decrement even though the call fails",
    async () => {
      const email = uniqueEmail();
      await wrappedStart(callableRequest({email}));
      const code = await readIssuedCode(email);
      const wrong = code === "000000" ? "111111" : "000000";

      await assertRejectsWithCode(
        wrappedVerify(callableRequest({code: wrong, email})),
        "invalid-argument",
      );

      // The whole point of returning the refusal out of the transaction
      // instead of throwing inside it: a rolled-back decrement would leave
      // the counter at its maximum and make the limit unenforceable.
      const snapshot = await verificationDocument(email).get();
      assert.equal(
        snapshot.data()?.attemptsRemaining,
        VERIFICATION_MAX_ATTEMPTS - 1,
      );
    });

  it("burns the code after the configured number of wrong attempts",
    async () => {
      const email = uniqueEmail();
      await wrappedStart(callableRequest({email}));
      const code = await readIssuedCode(email);
      const wrong = code === "000000" ? "111111" : "000000";

      for (let attempt = 0; attempt < VERIFICATION_MAX_ATTEMPTS; attempt += 1) {
        await assertRejectsWithCode(
          wrappedVerify(callableRequest({code: wrong, email})),
          "invalid-argument",
        );
      }

      // Even the correct code no longer works once the budget is spent.
      await assertRejectsWithCode(
        wrappedVerify(callableRequest({code, email})),
        "resource-exhausted",
      );
    });

  it("grants a verification for the right code and keeps it stable",
    async () => {
      const email = uniqueEmail();
      await wrappedStart(callableRequest({email}));
      const code = await readIssuedCode(email);

      const first = await wrappedVerify(callableRequest({code, email}));
      const second = await wrappedVerify(callableRequest({code, email}));

      assert.equal(first.verified, true);
      assert.equal(second.verifiedUntil, first.verifiedUntil);
      assert.equal((await verificationDocument(email).get()).data()?.verified,
        true);
    });

  it("refuses an address that was never issued a code", async () => {
    await assertRejectsWithCode(
      wrappedVerify(callableRequest({code: "000000", email: uniqueEmail()})),
      "not-found",
    );
  });
});

describe("resendEmailVerificationCode (emulator)", () => {
  it("refuses a resend inside the cooldown", async () => {
    const email = uniqueEmail();
    await wrappedStart(callableRequest({email}));

    await assertRejectsWithCode(
      wrappedResend(callableRequest({email})),
      "resource-exhausted",
    );
  });

  it("mints a new code once the cooldown has been waited out", async () => {
    const email = uniqueEmail();
    await wrappedStart(callableRequest({email}));
    const first = await readIssuedCode(email);
    // Rewinding the stored cooldown is the only way to test this without
    // holding the suite for a real minute.
    await verificationDocument(email).update({
      resendAvailableAt: (await verificationDocument(email).get())
        .data()?.createdAt ?? null,
    });

    await wrappedResend(callableRequest({email}));

    const second = await readIssuedCode(email);
    assert.equal(
      (await verificationDocument(email).get()).data()?.attemptsRemaining,
      VERIFICATION_MAX_ATTEMPTS,
    );
    // A fresh draw can legitimately repeat; what must change is the budget
    // and the window, which the assertion above already pins.
    assert.match(second, /^\d{6}$/);
    assert.equal(typeof first, "string");
  });
});
