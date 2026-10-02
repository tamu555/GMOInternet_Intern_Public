/**
 * Unit tests for `requireActiveUser`, following the dependency-substitution
 * pattern of `registration.test.ts`: no live Auth or Firestore connection.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {DocumentReference} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";

import {
  NOT_A_MEMBER_MESSAGE,
  requireActiveUser,
  UNAUTHENTICATED_MESSAGE,
} from "./callerGuard.js";
import type {CallerGuardDependencies} from "./callerGuard.js";
import {USER_STATUS} from "./constants.js";
import type {UserDocument, UserStatus} from "./types.js";

const UID = "caller-uid";

/**
 * Builds the only field the guard reads, cast to the full document type.
 *
 * @param {UserStatus} status Stored account status.
 * @return {UserDocument} Stand-in user document.
 */
function userWithStatus(status: UserStatus): UserDocument {
  return {status} as unknown as UserDocument;
}

/**
 * Dependencies whose user document resolves to the given data.
 *
 * @param {UserDocument|undefined} user Stored document, or undefined when
 * the document does not exist.
 * @param {string[]} readUids Collects the uids the guard looked up.
 * @return {CallerGuardDependencies} Substituted dependencies.
 */
function dependenciesReturning(
  user: UserDocument | undefined,
  readUids: string[] = [],
): CallerGuardDependencies {
  return {
    userDocument: (uid: string) => {
      readUids.push(uid);
      return {
        get: async () => ({data: () => user}),
      } as unknown as DocumentReference<UserDocument>;
    },
  };
}

/**
 * Dependencies whose user document read rejects.
 *
 * @param {Error} error Failure to raise from `get()`.
 * @return {CallerGuardDependencies} Substituted dependencies.
 */
function dependenciesFailing(error: Error): CallerGuardDependencies {
  return {
    userDocument: () => ({
      get: async () => {
        throw error;
      },
    }) as unknown as DocumentReference<UserDocument>,
  };
}

/**
 * Asserts that a call rejects with one specific HttpsError code and message.
 *
 * @param {Promise<unknown>} call The invocation under test.
 * @param {string} code Expected Callable error code.
 * @param {string} message Expected client-facing message.
 * @return {Promise<void>} Resolves once the assertion has run.
 */
async function assertRejectsWith(
  call: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof HttpsError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

describe("requireActiveUser", () => {
  it("returns the uid for an active member", async () => {
    const readUids: string[] = [];
    const uid = await requireActiveUser(
      {uid: UID},
      dependenciesReturning(userWithStatus(USER_STATUS.ACTIVE), readUids),
    );

    assert.equal(uid, UID);
    // The document read must be scoped to the caller, never to anything the
    // request body could influence.
    assert.deepEqual(readUids, [UID]);
  });

  it("rejects an unauthenticated call", async () => {
    await assertRejectsWith(
      requireActiveUser(undefined, dependenciesReturning(undefined)),
      "unauthenticated",
      UNAUTHENTICATED_MESSAGE,
    );
  });

  it("rejects a token that has no user document", async () => {
    // The accounts:signUp bypass: a valid ID token, no registration.
    await assertRejectsWith(
      requireActiveUser({uid: UID}, dependenciesReturning(undefined)),
      "permission-denied",
      NOT_A_MEMBER_MESSAGE,
    );
  });

  for (const status of [
    USER_STATUS.PENDING_ADDITIONAL_INFO,
    USER_STATUS.PENDING_DELETION,
    USER_STATUS.PURGING,
  ]) {
    it(`rejects a caller whose account is ${status}`, async () => {
      await assertRejectsWith(
        requireActiveUser(
          {uid: UID},
          dependenciesReturning(userWithStatus(status)),
        ),
        "permission-denied",
        NOT_A_MEMBER_MESSAGE,
      );
    });
  }

  // A Firestore outage must never be reported as a denial: that would tell a
  // legitimate member their account is gone.
  it("reports a Firestore failure as internal, not denial", async () => {
    await assertRejectsWith(
      requireActiveUser(
        {uid: UID},
        dependenciesFailing(new Error("firestore unavailable")),
      ),
      "internal",
      "処理できませんでした。",
    );
  });
});
