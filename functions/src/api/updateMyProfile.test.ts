/**
 * Callable-contract tests for `updateMyProfile`. The Firestore write is
 * substituted, so these run without a live Firestore. Covered: auth, input
 * validation ordering ahead of any write (invalid profile, unknown
 * top-level keys, non-object payloads), the not-active failure surfaced by
 * the transactional write, the echoed response shape, and that immutable
 * fields cannot be tunnelled through the request.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import {Timestamp} from "firebase-admin/firestore";

import type {ActiveUser, UserDocument, UserProfile} from "../auth/types";
import {
  handleUpdateMyProfile,
} from "./updateMyProfile";
import type {UpdateMyProfileDependencies} from "./updateMyProfile";

const UID = "member-uid-1";

const VALID_PROFILE: UserProfile = {
  name: "田中太郎",
  nameKana: "タナカ タロウ",
  phoneNumber: "09012345678",
  dateOfBirth: "1990-01-01",
  gender: "male",
  newsletterOptIn: true,
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
 * Builds an ActiveUser fixture, standing in for the row a fake `writeProfile`
 * would return.
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
    profile: VALID_PROFILE,
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

/** One recorded write. */
interface WriteCall {
  uid: string;
  profile: UserProfile;
}

/**
 * Builds recording fake dependencies.
 *
 * @param {UserDocument} result What the write resolves to.
 * @param {Function} onWrite Optional override for write behaviour (e.g. to
 *   simulate a not-active rejection).
 * @return {{deps: UpdateMyProfileDependencies, writes: WriteCall[]}} The fake
 *   dependency set and its call log.
 */
function fakeDependencies(
  result: UserDocument,
  onWrite?: (uid: string, profile: UserProfile) => Promise<UserDocument>,
): {deps: UpdateMyProfileDependencies; writes: WriteCall[]} {
  const writes: WriteCall[] = [];
  const deps: UpdateMyProfileDependencies = {
    writeProfile: async (uid, profile) => {
      writes.push({uid, profile});
      if (onWrite) return onWrite(uid, profile);
      return result;
    },
  };
  return {deps, writes};
}

describe("handleUpdateMyProfile", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies(activeUserDoc());
    await assertRejectsWith(
      () => handleUpdateMyProfile(
        callableRequest({profile: VALID_PROFILE}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects a corporate profile with no business info, before any write",
    async () => {
      const {deps, writes} = fakeDependencies(activeUserDoc());
      const invalid = {
        ...VALID_PROFILE,
        accountType: "corporate",
        business: null,
      };
      await assertRejectsWith(
        () => handleUpdateMyProfile(
          callableRequest({profile: invalid}, UID), deps),
        {code: "invalid-argument"},
      );
      assert.equal(writes.length, 0);
    });

  it("rejects an empty phone number, before any write", async () => {
    const {deps, writes} = fakeDependencies(activeUserDoc());
    const invalid = {...VALID_PROFILE, phoneNumber: ""};
    await assertRejectsWith(
      () => handleUpdateMyProfile(
        callableRequest({profile: invalid}, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(writes.length, 0);
  });

  it("rejects an unknown top-level key, before any write", async () => {
    const {deps, writes} = fakeDependencies(activeUserDoc());
    const payload = {
      profile: VALID_PROFILE,
      // An attempt to tunnel an immutable field through the same call.
      status: "purging",
    };
    await assertRejectsWith(
      () => handleUpdateMyProfile(
        callableRequest(payload, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(writes.length, 0);
  });

  it("rejects a non-object payload, before any write", async () => {
    const {deps, writes} = fakeDependencies(activeUserDoc());
    await assertRejectsWith(
      () => handleUpdateMyProfile(
        callableRequest("not-an-object", UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(writes.length, 0);
  });

  it("surfaces a not-active account as failed-precondition", async () => {
    const {deps} = fakeDependencies(activeUserDoc(), async () => {
      throw new HttpsError(
        "failed-precondition",
        "アカウントが有効な状態ではないため、プロフィールを更新できません。",
      );
    });
    await assertRejectsWith(
      () => handleUpdateMyProfile(
        callableRequest({profile: VALID_PROFILE}, UID), deps),
      {code: "failed-precondition"},
    );
  });

  it("writes only uid and the validated profile, echoing the same shape " +
    "getMyProfile returns",
  async () => {
    const stored = activeUserDoc({profile: VALID_PROFILE});
    const {deps, writes} = fakeDependencies(stored);
    const result = await handleUpdateMyProfile(
      callableRequest({profile: VALID_PROFILE}, UID), deps);

    assert.deepEqual(writes, [{uid: UID, profile: VALID_PROFILE}]);
    assert.deepEqual(result, {
      uid: UID,
      email: "member@example.com",
      authProvider: "password",
      status: "active",
      profile: VALID_PROFILE,
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:15:00.000Z",
    });
  });

  it("leaves uid/email/authProvider/status untouched by the request",
    async () => {
      // A caller cannot change accountType-adjacent identity fields via
      // this Callable: the write dependency only ever receives (uid,
      // profile), so a stored document's other fields survive verbatim,
      // as this fixture (a different email than any request field could
      // supply) demonstrates.
      const stored = activeUserDoc({
        email: "unchanged@example.com",
        authProvider: "google.com",
      });
      const {deps} = fakeDependencies(stored);
      const result = await handleUpdateMyProfile(
        callableRequest({profile: VALID_PROFILE}, UID), deps);
      assert.equal(result.email, "unchanged@example.com");
      assert.equal(result.authProvider, "google.com");
      assert.equal(result.status, "active");
      assert.equal(result.uid, UID);
    });
});
