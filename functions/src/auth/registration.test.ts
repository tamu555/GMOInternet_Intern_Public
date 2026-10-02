/**
 * Callable-contract tests for `handleRegisterWithEmailPassword`, following
 * `functions/src/api/infoCallables.test.ts`'s `handle*`-extraction pattern:
 * every dependency is substituted, so these run without a live Auth or
 * Firestore connection.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {Auth, UserRecord} from "firebase-admin/auth";
import type {DocumentReference} from "firebase-admin/firestore";
import {Timestamp} from "firebase-admin/firestore";
import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {
  AUTH_PROVIDER,
  USER_STATUS,
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_GRANT_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from "./constants.js";
import {handleRegisterWithEmailPassword} from "./registration.js";
import type {RegisterWithEmailPasswordDependencies} from "./registration.js";
import type {
  ActiveUser,
  UserDocument,
  VerificationCodeDocument,
} from "./types.js";

/** Fixed clock for every fixture, so grant windows are deterministic. */
const NOW_MS = 1_700_000_000_000;

const VALID_JAPAN_ADDRESS = {
  country: "JP" as const,
  postalCode: "123-4567",
  prefecture: "東京都",
  city: "千代田区",
  addressLine: "1-1-1",
  building: null,
};

const VALID_INTERNATIONAL_ADDRESS = {
  country: "US" as const,
  postalCode: "94105",
  state: "CA",
  city: "San Francisco",
  addressLine1: "1 Market St",
  addressLine2: null,
};

const VALID_BUSINESS = {
  companyName: "Integration Inc.",
  department: null,
  contactPerson: "Taro Yamada",
};

/**
 * Builds a valid full-profile registration payload.
 *
 * @param {Record<string, unknown>} overrides Fields to override.
 * @return {Record<string, unknown>} Registration Callable payload.
 */
function validRegistrationData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: "member@example.com",
    password: "Password123!",
    name: "山田太郎",
    nameKana: "ヤマダタロウ",
    phoneNumber: "090-1234-5678",
    dateOfBirth: "1990-01-01",
    gender: "no_answer",
    newsletterOptIn: false,
    accountType: "individual",
    business: null,
    address: VALID_JAPAN_ADDRESS,
    ...overrides,
  };
}

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

interface AuthCalls {
  getUserByEmailCalls: string[];
  createUserCalls: Array<{email: string; password: string}>;
  deleteUserCalls: string[];
}

interface AuthFixtureOptions {
  existingUser?: Pick<UserRecord, "uid" | "email"> | null;
  existingUserLookupError?: unknown;
  createdUser?: Pick<UserRecord, "uid" | "email">;
  createUserError?: unknown;
}

/**
 * Builds a fake Auth dependency recording every call made against it.
 *
 * @param {AuthFixtureOptions} options Fixture behavior.
 * @return {object} Fake `auth()` accessor and its call log.
 */
function buildAuthFixture(
  options: AuthFixtureOptions = {},
): {authFn: () => Auth; calls: AuthCalls} {
  const calls: AuthCalls = {
    createUserCalls: [],
    deleteUserCalls: [],
    getUserByEmailCalls: [],
  };
  const fakeAuthApi = {
    createUser: async (params: {email: string; password: string}) => {
      calls.createUserCalls.push(params);
      if (options.createUserError) {
        throw options.createUserError;
      }
      return options.createdUser ??
        {uid: "new-user-uid", email: params.email};
    },
    deleteUser: async (uid: string) => {
      calls.deleteUserCalls.push(uid);
    },
    getUserByEmail: async (email: string) => {
      calls.getUserByEmailCalls.push(email);
      if (options.existingUserLookupError) {
        throw options.existingUserLookupError;
      }
      if (!options.existingUser) {
        throw Object.assign(new Error("auth/user-not-found"), {
          code: "auth/user-not-found",
        });
      }
      return options.existingUser;
    },
  };
  return {authFn: () => fakeAuthApi as unknown as Auth, calls};
}

interface UserDocumentFixtureOptions {
  existingStatus?: UserDocument["status"];
  createError?: unknown;
}

/**
 * Builds a fake `userDocument(uid)` dependency recording writes.
 *
 * @param {UserDocumentFixtureOptions} options Fixture behavior.
 * @return {object} Fake accessor, its call log, and the created document.
 */
function buildUserDocumentFixture(
  options: UserDocumentFixtureOptions = {},
): {
  userDocumentFn: (uid: string) => DocumentReference<UserDocument>;
  createCalls: UserDocument[];
  requestedUids: string[];
} {
  const createCalls: UserDocument[] = [];
  const requestedUids: string[] = [];
  const userDocumentFn = (uid: string) => {
    requestedUids.push(uid);
    const ref = {
      create: async (document: UserDocument) => {
        createCalls.push(document);
        if (options.createError) {
          throw options.createError;
        }
      },
      get: async () => ({
        data: () => options.existingStatus === undefined ?
          undefined :
          ({status: options.existingStatus} as UserDocument),
      }),
    };
    return ref as unknown as DocumentReference<UserDocument>;
  };
  return {createCalls, requestedUids, userDocumentFn};
}

interface VerificationFixtureOptions {
  /** `null` means "no code was ever issued for this address". */
  stored?: VerificationCodeDocument | null;
}

/**
 * Builds a fake `verificationDocument(email)` dependency.
 *
 * @param {VerificationFixtureOptions} options Fixture behavior.
 * @return {object} Fake accessor plus its call logs.
 */
function buildVerificationFixture(options: VerificationFixtureOptions = {}): {
  verificationDocumentFn: (
    email: string,
  ) => DocumentReference<VerificationCodeDocument>;
  requestedEmails: string[];
  deletedEmails: string[];
} {
  const requestedEmails: string[] = [];
  const deletedEmails: string[] = [];
  const stored = options.stored === undefined ?
    verifiedGrant() :
    options.stored;

  const verificationDocumentFn = (email: string) => {
    requestedEmails.push(email);
    const ref = {
      delete: async () => {
        deletedEmails.push(email);
      },
      get: async () => ({data: () => stored ?? undefined}),
    };
    return ref as unknown as DocumentReference<VerificationCodeDocument>;
  };
  return {deletedEmails, requestedEmails, verificationDocumentFn};
}

/**
 * Builds a stored verification document holding a live grant.
 *
 * @param {Partial<VerificationCodeDocument>} overrides Fields to override.
 * @return {VerificationCodeDocument} Stored verification document.
 */
function verifiedGrant(
  overrides: Partial<VerificationCodeDocument> = {},
): VerificationCodeDocument {
  return {
    attemptsRemaining: VERIFICATION_MAX_ATTEMPTS,
    code: "123456",
    createdAt: Timestamp.fromMillis(NOW_MS),
    email: "member@example.com",
    expiresAt: Timestamp.fromMillis(NOW_MS + VERIFICATION_CODE_TTL_MS),
    resendAvailableAt: Timestamp.fromMillis(NOW_MS),
    updatedAt: Timestamp.fromMillis(NOW_MS),
    verified: true,
    verifiedUntil: Timestamp.fromMillis(NOW_MS + VERIFICATION_GRANT_TTL_MS),
    ...overrides,
  };
}

/**
 * Assembles a full dependency object from fixture builders.
 *
 * @param {AuthFixtureOptions} authOptions Auth fixture behavior.
 * @param {UserDocumentFixtureOptions} docOptions Firestore fixture behavior.
 * @param {VerificationFixtureOptions} verificationOptions Verification
 * fixture behavior; defaults to a live grant so tests that are not about
 * step 2 keep exercising the path they were written for.
 * @return {object} Dependencies plus call logs for assertions.
 */
function buildDeps(
  authOptions: AuthFixtureOptions = {},
  docOptions: UserDocumentFixtureOptions = {},
  verificationOptions: VerificationFixtureOptions = {},
): {
  deps: RegisterWithEmailPasswordDependencies;
  authCalls: AuthCalls;
  createCalls: UserDocument[];
  deletedEmails: string[];
} {
  const {authFn, calls: authCalls} = buildAuthFixture(authOptions);
  const {userDocumentFn, createCalls} = buildUserDocumentFixture(docOptions);
  const {verificationDocumentFn, deletedEmails} =
    buildVerificationFixture(verificationOptions);
  return {
    authCalls,
    createCalls,
    deletedEmails,
    deps: {
      auth: authFn,
      now: () => Timestamp.fromMillis(NOW_MS),
      userDocument: userDocumentFn,
      verificationDocument: verificationDocumentFn,
    },
  };
}

describe("handleRegisterWithEmailPassword: e-mail verification gate", () => {
  it("rejects an address that has never been issued a code", async () => {
    const {deps, authCalls} = buildDeps({}, {}, {stored: null});
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(validRegistrationData()),
        deps,
      ),
      "failed-precondition",
    );
    // Nothing was created: the gate runs before any Auth lookup.
    assert.deepEqual(authCalls.getUserByEmailCalls, []);
    assert.deepEqual(authCalls.createUserCalls, []);
  });

  it("rejects an address whose code was issued but never verified",
    async () => {
      const {deps} = buildDeps({}, {}, {
        stored: verifiedGrant({verified: false, verifiedUntil: null}),
      });
      await assertRejectsWithCode(
        () => handleRegisterWithEmailPassword(
          callableRequest(validRegistrationData()),
          deps,
        ),
        "failed-precondition",
      );
    });

  it("rejects an address whose verification grant has lapsed", async () => {
    const {deps} = buildDeps({}, {}, {
      stored: verifiedGrant({verifiedUntil: Timestamp.fromMillis(NOW_MS)}),
    });
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(validRegistrationData()),
        deps,
      ),
      "failed-precondition",
    );
  });

  it("spends the grant once the account exists", async () => {
    const {deps, deletedEmails} = buildDeps();

    await handleRegisterWithEmailPassword(
      callableRequest(validRegistrationData()),
      deps,
    );

    assert.deepEqual(deletedEmails, ["member@example.com"]);
  });

  it("leaves the grant in place when the account could not be created",
    async () => {
      const {deps, deletedEmails} = buildDeps({
        createUserError: Object.assign(new Error("boom"), {code: "unknown"}),
      });

      await assertRejectsWithCode(
        () => handleRegisterWithEmailPassword(
          callableRequest(validRegistrationData()),
          deps,
        ),
        "internal",
      );

      assert.deepEqual(deletedEmails, []);
    });
});

describe("handleRegisterWithEmailPassword: input validation", () => {
  it("rejects a non-object payload", async () => {
    const {deps} = buildDeps();
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(null), deps),
      "invalid-argument",
    );
  });

  it("rejects a missing email", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData();
    delete data.email;
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });

  it("rejects a missing password", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData();
    delete data.password;
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });

  it("rejects a disallowed email domain", async () => {
    const {deps, authCalls} = buildDeps();
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(validRegistrationData({email: "member@other.test"})),
        deps,
      ),
      "invalid-argument",
    );
    assert.equal(authCalls.getUserByEmailCalls.length, 0);
  });

  it("rejects a corporate account missing a business object", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData({
      accountType: "corporate",
      business: null,
    });
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });

  it("rejects a sole-proprietor missing contactPerson, identically to " +
    "corporate", async () => {
    const {deps} = buildDeps();
    const soleProprietorData = validRegistrationData({
      accountType: "sole-proprietor",
      business: {...VALID_BUSINESS, contactPerson: ""},
    });
    const corporateData = validRegistrationData({
      accountType: "corporate",
      business: {...VALID_BUSINESS, contactPerson: ""},
    });

    const soleProprietorError = await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(soleProprietorData),
        deps,
      ),
      "invalid-argument",
    );
    const corporateError = await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(corporateData),
        deps,
      ),
      "invalid-argument",
    );
    assert.equal(soleProprietorError.code, corporateError.code);
    assert.equal(soleProprietorError.message, corporateError.message);
  });

  it("rejects an individual account carrying a non-null business object " +
    "(the impossible direction)", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData({
      accountType: "individual",
      business: VALID_BUSINESS,
    });
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });

  it("rejects an invalid dateOfBirth", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData({dateOfBirth: "1990-02-30"});
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });

  it("rejects a hiragana nameKana", async () => {
    const {deps} = buildDeps();
    const data = validRegistrationData({nameKana: "やまだ"});
    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(callableRequest(data), deps),
      "invalid-argument",
    );
  });
});

describe("handleRegisterWithEmailPassword: existing account handling", () => {
  it("rejects an already-active account without creating an Auth user",
    async () => {
      const {deps, authCalls} = buildDeps(
        {existingUser: {email: "member@example.com", uid: "existing-uid"}},
        {existingStatus: USER_STATUS.ACTIVE},
      );

      await assertRejectsWithCode(
        () => handleRegisterWithEmailPassword(
          callableRequest(validRegistrationData()),
          deps,
        ),
        "already-exists",
      );
      assert.equal(authCalls.createUserCalls.length, 0);
    });

  it("rejects an account pending deletion", async () => {
    const {deps} = buildDeps(
      {existingUser: {email: "member@example.com", uid: "existing-uid"}},
      {existingStatus: USER_STATUS.PENDING_DELETION},
    );

    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(validRegistrationData()),
        deps,
      ),
      "already-exists",
    );
  });

  it("rejects an account currently purging", async () => {
    const {deps} = buildDeps(
      {existingUser: {email: "member@example.com", uid: "existing-uid"}},
      {existingStatus: USER_STATUS.PURGING},
    );

    await assertRejectsWithCode(
      () => handleRegisterWithEmailPassword(
        callableRequest(validRegistrationData()),
        deps,
      ),
      "already-exists",
    );
  });
});

describe("handleRegisterWithEmailPassword: Firestore write compensation",
  () => {
    it("deletes the newly created Auth user when the Firestore write fails",
      async () => {
        const {deps, authCalls} = buildDeps(
          {createdUser: {email: "member@example.com", uid: "created-uid"}},
          {createError: new Error("firestore unavailable")},
        );

        await assertRejectsWithCode(
          () => handleRegisterWithEmailPassword(
            callableRequest(validRegistrationData()),
            deps,
          ),
          "internal",
        );
        assert.deepEqual(authCalls.deleteUserCalls, ["created-uid"]);
      });
  });

describe("handleRegisterWithEmailPassword: success", () => {
  it("returns {uid, status:'active'} and persists the full nested profile",
    async () => {
      const {deps, authCalls, createCalls} = buildDeps({
        createdUser: {email: "member@example.com", uid: "created-uid"},
      });
      const data = validRegistrationData({
        accountType: "corporate",
        business: VALID_BUSINESS,
      });

      const result = await handleRegisterWithEmailPassword(
        callableRequest(data),
        deps,
      );

      assert.deepEqual(result, {status: "active", uid: "created-uid"});
      assert.equal(authCalls.createUserCalls.length, 1);
      assert.equal(authCalls.createUserCalls[0]?.email, "member@example.com");
      assert.equal(authCalls.createUserCalls[0]?.password, "Password123!");

      assert.equal(createCalls.length, 1);
      const written = createCalls[0] as ActiveUser;
      assert.equal(written.uid, "created-uid");
      assert.equal(written.email, "member@example.com");
      assert.equal(written.authProvider, AUTH_PROVIDER.PASSWORD);
      assert.equal(written.status, USER_STATUS.ACTIVE);
      assert.deepEqual(written.profile, {
        accountType: "corporate",
        address: VALID_JAPAN_ADDRESS,
        business: VALID_BUSINESS,
        dateOfBirth: "1990-01-01",
        gender: "no_answer",
        name: "山田太郎",
        nameKana: "ヤマダタロウ",
        newsletterOptIn: false,
        phoneNumber: "090-1234-5678",
      });
      assert.equal(
        Object.prototype.hasOwnProperty.call(written, "password"),
        false,
      );
      assert.equal(
        JSON.stringify(written).includes("Password123!"),
        false,
        "the plaintext password must never be persisted on the user document",
      );
    });

  it("persists an international address unchanged (the non-Japan branch " +
    "of the address discriminated union)", async () => {
    const {deps, createCalls} = buildDeps({
      createdUser: {email: "member@example.com", uid: "created-uid"},
    });
    const data = validRegistrationData({address: VALID_INTERNATIONAL_ADDRESS});

    const result = await handleRegisterWithEmailPassword(
      callableRequest(data),
      deps,
    );

    assert.deepEqual(result, {status: "active", uid: "created-uid"});
    assert.equal(createCalls.length, 1);
    const written = createCalls[0] as ActiveUser;
    assert.deepEqual(written.profile.address, VALID_INTERNATIONAL_ADDRESS);
  });

  it("persists a sole-proprietor registration with its business info, " +
    "with accountType stored as 'sole-proprietor'", async () => {
    const {deps, createCalls} = buildDeps({
      createdUser: {email: "member@example.com", uid: "created-uid"},
    });
    const data = validRegistrationData({
      accountType: "sole-proprietor",
      business: VALID_BUSINESS,
    });

    const result = await handleRegisterWithEmailPassword(
      callableRequest(data),
      deps,
    );

    assert.deepEqual(result, {status: "active", uid: "created-uid"});
    assert.equal(createCalls.length, 1);
    const written = createCalls[0] as ActiveUser;
    assert.equal(written.profile.accountType, "sole-proprietor");
    assert.deepEqual(written.profile.business, VALID_BUSINESS);
  });
});
