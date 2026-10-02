/**
 * Callable-contract tests for `getMyProfile`. The Firestore read is
 * substituted, so these run without a live Firestore. Covered: auth, the
 * defensive not-found branch, the response projection (ISO timestamps,
 * `authProvider`/`status` included), and that `serializeUserDocument` never
 * leaks deletion-flow-only fields.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {Timestamp} from "firebase-admin/firestore";

import type {ActiveUser, UserDocument, UserProfile} from "../auth/types";
import {
  handleGetMyProfile,
  serializeUserDocument,
} from "./getMyProfile";
import type {GetMyProfileDependencies} from "./getMyProfile";

const UID = "member-uid-1";

const PROFILE: UserProfile = {
  name: "田中太郎",
  nameKana: "タナカ タロウ",
  phoneNumber: "09012345678",
  dateOfBirth: "1990-01-01",
  gender: "male",
  newsletterOptIn: false,
  accountType: "individual",
  business: null,
  address: {
    country: "JP",
    postalCode: "100-0001",
    prefecture: "東京都",
    city: "千代田区",
    addressLine: "千代田1-1",
    building: null,
  },
};

/**
 * Builds an ActiveUser fixture.
 *
 * @param {Partial<ActiveUser>} overrides Field overrides.
 * @return {ActiveUser} A stored active user document.
 */
function activeUserDoc(overrides: Partial<ActiveUser> = {}): ActiveUser {
  return {
    uid: UID,
    email: "member@example.com",
    authProvider: "password",
    status: "active",
    profile: PROFILE,
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_100_000),
    deletionRequestedAt: null,
    scheduledPurgeAt: null,
    purgeTaskName: null,
    ...overrides,
  };
}

/**
 * Builds the request shape received after Callable authentication.
 *
 * @param {T} data Callable request data.
 * @param {string} uid Authenticated fixture UID, omitted for the
 *   unauthenticated case.
 * @return {CallableRequest<T>} Synthetic Callable request.
 */
function callableRequest<T>(data: T, uid?: string): CallableRequest<T> {
  const base = {
    acceptsStreaming: false,
    data,
    rawRequest: {},
  } as CallableRequest<T>;
  if (uid === undefined) return base;
  return {
    ...base,
    auth: {
      uid,
      token: {uid, sub: uid, auth_time: Math.floor(Date.now() / 1000)},
      rawToken: "test-token",
    },
  } as CallableRequest<T>;
}

/**
 * Asserts that a Callable rejects with the given HttpsError contract.
 *
 * @param {Function} action Callable invocation.
 * @param {object} expected Expected code and optional message.
 * @return {Promise<void>} Resolves when the rejection matched.
 */
async function assertRejectsWith(
  action: () => Promise<unknown>,
  expected: {code: string; message?: string},
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expected.code);
    if (expected.message !== undefined) {
      assert.equal((error as HttpsError).message, expected.message);
    }
    return true;
  });
}

/**
 * Builds fake dependencies around one stored user document.
 *
 * @param {UserDocument | null} user What the loader answers.
 * @return {GetMyProfileDependencies} Fake dependency set.
 */
function fakeDependencies(
  user: UserDocument | null,
): GetMyProfileDependencies {
  return {
    loadUser: async () => user,
  };
}

describe("handleGetMyProfile", () => {
  it("rejects unauthenticated calls", async () => {
    const deps = fakeDependencies(activeUserDoc());
    await assertRejectsWith(
      () => handleGetMyProfile(callableRequest({}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects a caller with no stored document", async () => {
    const deps = fakeDependencies(null);
    await assertRejectsWith(
      () => handleGetMyProfile(callableRequest({}, UID), deps),
      {code: "permission-denied"},
    );
  });

  it("returns the caller's own profile with ISO timestamps", async () => {
    const deps = fakeDependencies(activeUserDoc());
    const result = await handleGetMyProfile(callableRequest({}, UID), deps);
    assert.deepEqual(result, {
      uid: UID,
      email: "member@example.com",
      authProvider: "password",
      status: "active",
      profile: PROFILE,
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:15:00.000Z",
    });
  });

  it("returns a null profile for a pending_additional_info account",
    async () => {
      const deps = fakeDependencies({
        ...activeUserDoc(),
        status: "pending_additional_info",
        profile: null,
      } as UserDocument);
      const result = await handleGetMyProfile(callableRequest({}, UID), deps);
      assert.equal(result.status, "pending_additional_info");
      assert.equal(result.profile, null);
    });
});

describe("serializeUserDocument", () => {
  it("never leaks deletion-flow-only fields", () => {
    const user = activeUserDoc({
      deletionRequestedAt: Timestamp.now(),
      scheduledPurgeAt: Timestamp.now(),
      purgeTaskName: "some-task-id",
    });
    const result = serializeUserDocument(user);
    assert.deepEqual(Object.keys(result).sort(), [
      "authProvider",
      "createdAt",
      "email",
      "profile",
      "status",
      "uid",
      "updatedAt",
    ]);
  });
});
