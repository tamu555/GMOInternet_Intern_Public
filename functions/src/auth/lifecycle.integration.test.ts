import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, describe, it} from "node:test";

import {getFunctions} from "firebase-admin/functions";
import {Timestamp} from "firebase-admin/firestore";
import type {CallableRequest} from "firebase-functions/v2/https";
import firebaseFunctionsTest from "firebase-functions-test";

import {adminAuth as auth} from "../config/firebase.js";
import {REGION} from "../config/options.js";
import {
  deleteAccountWithGoogle,
  deleteAccountWithPassword,
  purgePendingAccount,
  restoreAccount,
  submitAdditionalInfo,
} from "./account-lifecycle.js";
import {cleanupAbandonedGoogleSignups} from "./cleanup.js";
import {
  ABANDONED_SIGNUP_CLEANUP_DAYS,
  AUTH_PROVIDER,
  AUTH_TIME_FRESHNESS_SECONDS,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_SECOND,
  PURGING_RETRY_DELAY_SECONDS,
  USER_STATUS,
} from "./constants.js";
import {userDocument} from "./firestore.js";
import type {AuthProvider, UserDocument, UserStatus} from "./types.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "teamc-2026";
const TEST_PASSWORD = "integration-password-123";
const TEST_CLOCK_SKEW_MILLISECONDS = 1_000;

const FIXTURE_JAPAN_ADDRESS = {
  addressLine: "1-1-1",
  building: null,
  city: "千代田区",
  country: "JP" as const,
  postalCode: "123-4567",
  prefecture: "東京都",
};

const FIXTURE_INTERNATIONAL_ADDRESS = {
  addressLine1: "1 Market St",
  addressLine2: null,
  city: "San Francisco",
  country: "US" as const,
  postalCode: "94105",
  state: "CA",
};

/** Default full profile used by fixtures already in an active-shaped state. */
const FIXTURE_PROFILE = {
  accountType: "individual" as const,
  address: FIXTURE_JAPAN_ADDRESS,
  business: null,
  dateOfBirth: "1990-01-01",
  gender: "no_answer" as const,
  name: "Name",
  nameKana: "ナマエ",
  newsletterOptIn: false,
  phoneNumber: "090-1234-5678",
};

/** Full profile submitted through `submitAdditionalInfo` in the happy path. */
const SUBMITTED_PROFILE = {
  accountType: "individual" as const,
  address: {
    addressLine: "2-2-2",
    building: "  Suite 3  ",
    city: "  Chiyoda  ",
    country: "JP" as const,
    postalCode: "100-0001",
    prefecture: "東京都",
  },
  business: null,
  dateOfBirth: "1985-05-05",
  gender: "female" as const,
  name: "  Integration User  ",
  nameKana: "  インテグレーションユーザー  ",
  newsletterOptIn: true,
  phoneNumber: "  090-9999-8888  ",
};

interface FixtureOptions {
  authProvider: AuthProvider;
  status: UserStatus;
  createAuthUser?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  deletionRequestedAt?: Timestamp | null;
  scheduledPurgeAt?: Timestamp | null;
  purgeTaskName?: string | null;
}

interface UserFixture {
  uid: string;
  email: string;
}

const testEnvironment = firebaseFunctionsTest({projectId: PROJECT_ID});
const wrappedSubmitAdditionalInfo = testEnvironment.wrap(
  submitAdditionalInfo,
);
const wrappedDeleteAccountWithPassword = testEnvironment.wrap(
  deleteAccountWithPassword,
);
const wrappedDeleteAccountWithGoogle = testEnvironment.wrap(
  deleteAccountWithGoogle,
);
const wrappedRestoreAccount = testEnvironment.wrap(restoreAccount);
const purgeTaskQueue = getFunctions(auth().app).taskQueue(
  `locations/${REGION}/functions/purgeAccount`,
);

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for integration tests.",
  );
  assert.ok(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    "FIREBASE_AUTH_EMULATOR_HOST is required for integration tests.",
  );
  assert.ok(
    process.env.CLOUD_TASKS_EMULATOR_HOST,
    "CLOUD_TASKS_EMULATOR_HOST is required for integration tests.",
  );
});

after(() => {
  testEnvironment.cleanup();
});

/**
 * Creates one independently identifiable Auth/Firestore account fixture.
 *
 * @param {FixtureOptions} options Lifecycle state to seed.
 * @return {Promise<UserFixture>} Fixture identifiers.
 */
async function seedUser(options: FixtureOptions): Promise<UserFixture> {
  const suffix = randomUUID();
  const uid = `lifecycle-${suffix}`;
  const email = `lifecycle-${suffix}@example.com`;
  const now = Timestamp.now();

  if (options.createAuthUser !== false) {
    await auth().createUser({
      uid,
      email,
      password: options.authProvider === AUTH_PROVIDER.PASSWORD ?
        TEST_PASSWORD : undefined,
    });
  }

  const common = {
    uid,
    email,
    authProvider: options.authProvider,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    deletionRequestedAt: options.deletionRequestedAt ?? null,
    scheduledPurgeAt: options.scheduledPurgeAt ?? null,
    purgeTaskName: options.purgeTaskName ?? null,
  };
  // `UserDocument` is a status-discriminated union: `profile` is `null`
  // only for `pending_additional_info`, never for the other three statuses.
  const {status} = options;
  const user: UserDocument = status === USER_STATUS.PENDING_ADDITIONAL_INFO ?
    {...common, profile: null, status} :
    {...common, profile: FIXTURE_PROFILE, status};
  await userDocument(uid).set(user);
  return {uid, email};
}

/**
 * Builds the request shape received after Callable authentication succeeds.
 *
 * @param {string} uid Authenticated fixture UID.
 * @param {unknown} data Callable request data.
 * @param {number} authTime Firebase auth_time claim in UNIX seconds.
 * @return {CallableRequest<unknown>} Synthetic verified Callable request.
 */
function callableRequest(
  uid: string,
  data: unknown = {},
  authTime = Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
): CallableRequest<unknown> {
  return {
    data,
    auth: {
      uid,
      token: {
        uid,
        sub: uid,
        auth_time: authTime,
      },
    },
    acceptsStreaming: false,
    rawRequest: {},
  } as CallableRequest<unknown>;
}

/**
 * Asserts that a Callable rejects with one stable Functions error code.
 *
 * @param {Function} action Callable invocation.
 * @param {string} expectedCode Expected HttpsError code.
 * @return {Promise<void>} Resolves after the rejection is verified.
 */
async function assertRejectsWithCode(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal(
      (error as {code?: unknown}).code,
      expectedCode,
    );
    return true;
  });
}

/**
 * Reports whether an Auth fixture is still present.
 *
 * @param {string} uid Firebase Auth user ID.
 * @return {Promise<boolean>} Whether the user exists.
 */
async function authUserExists(uid: string): Promise<boolean> {
  try {
    await auth().getUser(uid);
    return true;
  } catch (error: unknown) {
    if ((error as {code?: unknown}).code === "auth/user-not-found") {
      return false;
    }
    throw error;
  }
}

/**
 * Reads the refresh-token revocation cutoff persisted by Firebase Auth.
 *
 * @param {string} uid Firebase Auth user ID.
 * @return {Promise<number>} Revocation cutoff in UNIX milliseconds.
 */
async function readTokensValidAfter(uid: string): Promise<number> {
  const value = (await auth().getUser(uid)).tokensValidAfterTime;
  assert.equal(typeof value, "string");
  const milliseconds = Date.parse(value as string);
  assert.equal(Number.isNaN(milliseconds), false);
  return milliseconds;
}

/**
 * Removes one test account and any delayed purge tasks it scheduled.
 *
 * @param {UserFixture} fixture Fixture to remove.
 * @param {Iterable<string>} taskIds Scheduled task IDs to remove.
 * @return {Promise<void>} Resolves after idempotent cleanup.
 */
async function cleanupFixture(
  fixture: UserFixture,
  taskIds: Iterable<string> = [],
): Promise<void> {
  const pendingTaskIds = new Set(taskIds);
  const storedTaskId = (await userDocument(fixture.uid).get())
    .data()?.purgeTaskName;
  if (typeof storedTaskId === "string") {
    pendingTaskIds.add(storedTaskId);
  }
  for (const taskId of pendingTaskIds) {
    await purgeTaskQueue.delete(taskId);
  }
  await userDocument(fixture.uid).delete();
  try {
    await auth().deleteUser(fixture.uid);
  } catch (error: unknown) {
    if ((error as {code?: unknown}).code !== "auth/user-not-found") {
      throw error;
    }
  }
}

/**
 * Reads and validates a scheduled purge task ID from Firestore.
 *
 * @param {string} uid Fixture UID.
 * @return {Promise<string>} Persisted non-empty task ID.
 */
async function readPurgeTaskId(uid: string): Promise<string> {
  const taskId = (await userDocument(uid).get()).data()?.purgeTaskName;
  assert.equal(typeof taskId, "string");
  assert.notEqual(taskId, "");
  return taskId as string;
}

describe("submitAdditionalInfo emulator integration", () => {
  it("transitions a pending Google signup to active with the full profile",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.PENDING_ADDITIONAL_INFO,
      });
      try {
        const result = await wrappedSubmitAdditionalInfo(
          callableRequest(fixture.uid, SUBMITTED_PROFILE),
        );

        assert.deepEqual(result, {status: USER_STATUS.ACTIVE});
        const stored = (await userDocument(fixture.uid).get()).data();
        assert.equal(stored?.status, USER_STATUS.ACTIVE);
        if (stored?.status === USER_STATUS.ACTIVE) {
          assert.equal(stored.profile.name, "Integration User");
          assert.equal(
            stored.profile.nameKana,
            "インテグレーションユーザー",
          );
          assert.equal(stored.profile.phoneNumber, "090-9999-8888");
          assert.equal(stored.profile.address.country, "JP");
          if (stored.profile.address.country === "JP") {
            assert.equal(stored.profile.address.building, "Suite 3");
            assert.equal(stored.profile.address.city, "Chiyoda");
          }
          assert.equal(stored.profile.newsletterOptIn, true);
          assert.equal(stored.profile.accountType, "individual");
          assert.equal(stored.profile.business, null);
        }
      } finally {
        await cleanupFixture(fixture);
      }
    });

  it("persists an international address unchanged (the non-Japan branch " +
    "of the address discriminated union), verified through a real " +
    "Firestore round trip", async () => {
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.GOOGLE,
      status: USER_STATUS.PENDING_ADDITIONAL_INFO,
    });
    try {
      const result = await wrappedSubmitAdditionalInfo(
        callableRequest(fixture.uid, {
          ...SUBMITTED_PROFILE,
          address: FIXTURE_INTERNATIONAL_ADDRESS,
        }),
      );

      assert.deepEqual(result, {status: USER_STATUS.ACTIVE});
      const stored = (await userDocument(fixture.uid).get()).data();
      assert.equal(stored?.status, USER_STATUS.ACTIVE);
      if (stored?.status === USER_STATUS.ACTIVE) {
        assert.deepEqual(stored.profile.address, FIXTURE_INTERNATIONAL_ADDRESS);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("transitions a pending Google signup to active with a sole-proprietor " +
    "profile, with accountType stored as 'sole-proprietor'", async () => {
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.GOOGLE,
      status: USER_STATUS.PENDING_ADDITIONAL_INFO,
    });
    const business = {
      companyName: "Integration Trade Name",
      contactPerson: "Integration Contact",
      department: null,
    };
    try {
      const result = await wrappedSubmitAdditionalInfo(
        callableRequest(fixture.uid, {
          ...SUBMITTED_PROFILE,
          accountType: "sole-proprietor",
          business,
        }),
      );

      assert.deepEqual(result, {status: USER_STATUS.ACTIVE});
      const stored = (await userDocument(fixture.uid).get()).data();
      assert.equal(stored?.status, USER_STATUS.ACTIVE);
      if (stored?.status === USER_STATUS.ACTIVE) {
        assert.equal(stored.profile.accountType, "sole-proprietor");
        assert.deepEqual(stored.profile.business, business);
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects a corporate profile missing business info, then a " +
    "sole-proprietor profile with the same gap, identically", async () => {
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.GOOGLE,
      status: USER_STATUS.PENDING_ADDITIONAL_INFO,
    });
    try {
      await assertRejectsWithCode(
        () => wrappedSubmitAdditionalInfo(callableRequest(fixture.uid, {
          ...SUBMITTED_PROFILE,
          accountType: "corporate",
          business: null,
        })),
        "invalid-argument",
      );
      await assertRejectsWithCode(
        () => wrappedSubmitAdditionalInfo(callableRequest(fixture.uid, {
          ...SUBMITTED_PROFILE,
          accountType: "sole-proprietor",
          business: null,
        })),
        "invalid-argument",
      );
      assert.equal(
        (await userDocument(fixture.uid).get()).data()?.status,
        USER_STATUS.PENDING_ADDITIONAL_INFO,
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects an individual profile carrying a non-null business object",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.PENDING_ADDITIONAL_INFO,
      });
      try {
        await assertRejectsWithCode(
          () => wrappedSubmitAdditionalInfo(callableRequest(fixture.uid, {
            ...SUBMITTED_PROFILE,
            accountType: "individual",
            business: {
              companyName: "Should Not Be Here",
              contactPerson: "N/A",
              department: null,
            },
          })),
          "invalid-argument",
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });

  it("rejects a user that is already active", async () => {
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.GOOGLE,
      status: USER_STATUS.ACTIVE,
    });
    try {
      await assertRejectsWithCode(
        () => wrappedSubmitAdditionalInfo(
          callableRequest(fixture.uid, SUBMITTED_PROFILE),
        ),
        "failed-precondition",
      );
      assert.equal(
        (await userDocument(fixture.uid).get()).data()?.status,
        USER_STATUS.ACTIVE,
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });
});

describe("account deletion emulator integration", () => {
  it("prepares password deletion, enqueues a task, and revokes tokens",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.ACTIVE,
      });
      const taskIds = new Set<string>();
      try {
        const startedAt = Date.now();
        const result = await wrappedDeleteAccountWithPassword(
          callableRequest(fixture.uid),
        );
        taskIds.add(await readPurgeTaskId(fixture.uid));

        assert.equal(result.status, USER_STATUS.PENDING_DELETION);
        assert.equal(Number.isNaN(Date.parse(result.scheduledPurgeAt)), false);
        const stored = (await userDocument(fixture.uid).get()).data();
        assert.equal(stored?.status, USER_STATUS.PENDING_DELETION);
        assert.ok(stored?.deletionRequestedAt instanceof Timestamp);
        assert.ok(stored?.scheduledPurgeAt instanceof Timestamp);
        assert.equal(
          stored?.scheduledPurgeAt?.toDate().toISOString(),
          result.scheduledPurgeAt,
        );

        const revokedAt = await readTokensValidAfter(fixture.uid);
        assert.ok(revokedAt >= startedAt - TEST_CLOCK_SKEW_MILLISECONDS);
        assert.ok(revokedAt <= Date.now() + TEST_CLOCK_SKEW_MILLISECONDS);
      } finally {
        await cleanupFixture(fixture, taskIds);
      }
    });

  it("prepares Google deletion, enqueues a task, and revokes tokens",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.ACTIVE,
      });
      const taskIds = new Set<string>();
      try {
        const startedAt = Date.now();
        const result = await wrappedDeleteAccountWithGoogle(
          callableRequest(fixture.uid),
        );
        taskIds.add(await readPurgeTaskId(fixture.uid));

        assert.equal(result.status, USER_STATUS.PENDING_DELETION);
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.PENDING_DELETION,
        );
        const revokedAt = await readTokensValidAfter(fixture.uid);
        assert.ok(revokedAt >= startedAt - TEST_CLOCK_SKEW_MILLISECONDS);
        assert.ok(revokedAt <= Date.now() + TEST_CLOCK_SKEW_MILLISECONDS);
      } finally {
        await cleanupFixture(fixture, taskIds);
      }
    });

  it("rejects an auth_time outside the freshness window", async () => {
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.PASSWORD,
      status: USER_STATUS.ACTIVE,
    });
    try {
      const staleAuthTime = Math.floor(
        Date.now() / MILLISECONDS_PER_SECOND,
      ) - AUTH_TIME_FRESHNESS_SECONDS - 1;
      await assertRejectsWithCode(
        () => wrappedDeleteAccountWithPassword(
          callableRequest(fixture.uid, {}, staleAuthTime),
        ),
        "failed-precondition",
      );
      assert.equal(
        (await userDocument(fixture.uid).get()).data()?.status,
        USER_STATUS.ACTIVE,
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects a deletion handler that does not match the provider",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.ACTIVE,
      });
      try {
        await assertRejectsWithCode(
          () => wrappedDeleteAccountWithGoogle(
            callableRequest(fixture.uid),
          ),
          "permission-denied",
        );
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.ACTIVE,
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });
});

describe("restore and purge transaction safety", () => {
  it("restores pending deletion before its deadline", async () => {
    const now = Timestamp.now();
    const fixture = await seedUser({
      authProvider: AUTH_PROVIDER.PASSWORD,
      status: USER_STATUS.PENDING_DELETION,
      deletionRequestedAt: now,
      scheduledPurgeAt: Timestamp.fromMillis(
        now.toMillis() + MILLISECONDS_PER_DAY,
      ),
      purgeTaskName: `fixture-${randomUUID()}`,
    });
    try {
      const result = await wrappedRestoreAccount(
        callableRequest(fixture.uid),
      );

      assert.deepEqual(result, {status: USER_STATUS.ACTIVE});
      const stored = (await userDocument(fixture.uid).get()).data();
      assert.equal(stored?.status, USER_STATUS.ACTIVE);
      assert.equal(stored?.deletionRequestedAt, null);
      assert.equal(stored?.scheduledPurgeAt, null);
      assert.equal(stored?.purgeTaskName, null);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects restore after purge has claimed the Firestore document",
    async () => {
      const now = Timestamp.now();
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.PENDING_DELETION,
        createAuthUser: false,
        deletionRequestedAt: now,
        scheduledPurgeAt: Timestamp.fromMillis(
          now.toMillis() + MILLISECONDS_PER_DAY,
        ),
      });
      try {
        await assertRejectsWithCode(
          () => purgePendingAccount(fixture.uid),
          "auth/user-not-found",
        );
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.PURGING,
        );

        await assertRejectsWithCode(
          () => wrappedRestoreAccount(callableRequest(fixture.uid)),
          "failed-precondition",
        );
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.PURGING,
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });

  it("physically deletes Auth and Firestore after claiming pending deletion",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.PENDING_DELETION,
        deletionRequestedAt: Timestamp.now(),
        scheduledPurgeAt: Timestamp.fromMillis(Date.now() - 1),
      });
      try {
        assert.equal(await purgePendingAccount(fixture.uid), true);
        assert.equal(await authUserExists(fixture.uid), false);
        assert.equal((await userDocument(fixture.uid).get()).exists, false);
      } finally {
        await cleanupFixture(fixture);
      }
    });

  it("is a safe no-op after a concurrent restore made the account active",
    async () => {
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.ACTIVE,
      });
      try {
        assert.equal(await purgePendingAccount(fixture.uid), false);
        assert.equal(await authUserExists(fixture.uid), true);
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.ACTIVE,
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });

  it("serializes simultaneous restore and purge into one safe outcome",
    async () => {
      const now = Timestamp.now();
      const fixture = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.PENDING_DELETION,
        deletionRequestedAt: now,
        scheduledPurgeAt: Timestamp.fromMillis(
          now.toMillis() + MILLISECONDS_PER_DAY,
        ),
      });
      try {
        const [purgeResult, restoreResult] = await Promise.allSettled([
          purgePendingAccount(fixture.uid),
          wrappedRestoreAccount(callableRequest(fixture.uid)),
        ]);

        assert.equal(purgeResult.status, "fulfilled");
        if (purgeResult.status !== "fulfilled") {
          return;
        }
        if (purgeResult.value) {
          assert.equal(restoreResult.status, "rejected");
          if (restoreResult.status === "rejected") {
            assert.equal(
              (restoreResult.reason as {code?: unknown}).code,
              "failed-precondition",
            );
          }
          assert.equal(await authUserExists(fixture.uid), false);
          assert.equal((await userDocument(fixture.uid).get()).exists, false);
          return;
        }

        assert.equal(restoreResult.status, "fulfilled");
        if (restoreResult.status === "fulfilled") {
          assert.deepEqual(restoreResult.value, {status: USER_STATUS.ACTIVE});
        }
        assert.equal(await authUserExists(fixture.uid), true);
        assert.equal(
          (await userDocument(fixture.uid).get()).data()?.status,
          USER_STATUS.ACTIVE,
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });
});

describe("scheduled account cleanup integration", () => {
  it("runs abandoned, overdue, and stuck-purge passes independently",
    async () => {
      const now = Timestamp.now();
      const abandoned = await seedUser({
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.PENDING_ADDITIONAL_INFO,
        createdAt: Timestamp.fromMillis(
          now.toMillis() -
            ABANDONED_SIGNUP_CLEANUP_DAYS * MILLISECONDS_PER_DAY - 1,
        ),
      });
      const recent = await seedUser({
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.PENDING_ADDITIONAL_INFO,
        createdAt: now,
      });
      const overdue = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.PENDING_DELETION,
        deletionRequestedAt: Timestamp.fromMillis(now.toMillis() - 2),
        scheduledPurgeAt: Timestamp.fromMillis(now.toMillis() - 1),
      });
      const stuck = await seedUser({
        authProvider: AUTH_PROVIDER.PASSWORD,
        status: USER_STATUS.PURGING,
        updatedAt: Timestamp.fromMillis(
          now.toMillis() -
            PURGING_RETRY_DELAY_SECONDS * MILLISECONDS_PER_SECOND - 1,
        ),
      });
      const fixtures = [abandoned, recent, overdue, stuck];
      try {
        await cleanupAbandonedGoogleSignups.run({
          jobName: "lifecycle-integration-cleanup",
          scheduleTime: new Date().toISOString(),
        });

        for (const deleted of [abandoned, overdue, stuck]) {
          assert.equal(await authUserExists(deleted.uid), false);
          assert.equal((await userDocument(deleted.uid).get()).exists, false);
        }
        assert.equal(await authUserExists(recent.uid), true);
        assert.equal(
          (await userDocument(recent.uid).get()).data()?.status,
          USER_STATUS.PENDING_ADDITIONAL_INFO,
        );
      } finally {
        for (const fixture of fixtures) {
          await cleanupFixture(fixture);
        }
      }
    });
});
