/**
 * Callable-contract tests for the account-deletion domain-ownership guard
 * added to `prepareDeletion`. Firestore, Cloud Tasks, and Auth are all
 * substituted with in-memory fakes (the same style `verification.test.ts`
 * and `updateFunctions.test.ts` use), so these run without a live emulator.
 *
 * Covered: both deletion Callables (`deleteAccountWithPassword` and
 * `deleteAccountWithGoogle`) refuse while the caller owns any domain, with
 * the fixed `failed-precondition` / `details.reason === "domains_owned"`
 * contract, no Firestore state change, and no purge task enqueued; both
 * still succeed once the domain count is zero; and, independently,
 * `countOwnedDomainsInTransaction`'s own `lifecycle === "gone"` exclusion
 * (a fake `transaction.get()` stands in for the Firestore query result,
 * since the exclusion logic itself - not Firestore's query engine - is what
 * needs coverage here). Composing the two: a member whose domains are all
 * `gone` gets a count of 0 from the latter, and the former already proves a
 * count of 0 lets the deletion through.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {DocumentReference} from "firebase-admin/firestore";
import {Timestamp} from "firebase-admin/firestore";
import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {
  countOwnedDomainsInTransaction,
  handleDeleteAccountWithGoogle,
  handleDeleteAccountWithPassword,
} from "./account-lifecycle.js";
import type {AccountDeletionDependencies} from "./account-lifecycle.js";
import {AUTH_PROVIDER, USER_STATUS} from "./constants.js";
import type {ActiveUser, UserDocument} from "./types.js";

const UID = "member-uid-1";
const NOW_MS = 1_700_000_000_000;

const DOMAINS_OWNED_MESSAGE =
  "保有中のドメインがあるため退会できません。先にドメインを廃止または移管し" +
  "てください。";

/**
 * Builds an active-user fixture stored under `users/{uid}`.
 *
 * @param {AuthProvider} authProvider Stored provider.
 * @return {ActiveUser} A stored active user document.
 */
function activeUserDoc(
  authProvider: ActiveUser["authProvider"] = AUTH_PROVIDER.PASSWORD,
): ActiveUser {
  return {
    uid: UID,
    email: "member@example.com",
    authProvider,
    status: "active",
    profile: {
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
    },
    createdAt: Timestamp.fromMillis(NOW_MS - 1_000),
    updatedAt: Timestamp.fromMillis(NOW_MS - 1_000),
    deletionRequestedAt: null,
    scheduledPurgeAt: null,
    purgeTaskName: null,
  };
}

/**
 * Builds the request shape received after Callable authentication.
 *
 * @param {string} uid Authenticated fixture UID.
 * @return {CallableRequest<unknown>} Synthetic Callable request.
 */
function callableRequest(uid: string): CallableRequest<unknown> {
  // `requireFreshAuthentication` compares against the real wall clock, so
  // this must be "now", independent of the fixture-timestamp NOW_MS used
  // for the stored document's createdAt/updatedAt above.
  const authTimeSeconds = Math.floor(Date.now() / 1_000);
  return {
    acceptsStreaming: false,
    data: {},
    rawRequest: {},
    auth: {
      uid,
      token: {uid, sub: uid, auth_time: authTimeSeconds},
      rawToken: "test-token",
    },
  } as CallableRequest<unknown>;
}

interface FakeOptions {
  /** Seed of `users/{uid}`; omit for a missing document. */
  user?: UserDocument | null;
  /** Owned-domain count `countOwnedDomains` reports. */
  domainCount?: number;
}

/**
 * Builds an `AccountDeletionDependencies` set backed by in-memory fakes: one
 * `users/{uid}` slot behind a real-transaction-shaped `runTransaction` (a
 * throw inside the callback leaves the stored document untouched, exactly
 * like a rolled-back Firestore transaction), plus recording fakes for the
 * purge-task enqueue, token revocation, and domain count.
 *
 * @param {FakeOptions} options Fixture behaviour.
 * @return {object} Dependencies, a reader for the stored document, and call
 *   logs for the enqueue/revoke/count side effects.
 */
function buildDeps(options: FakeOptions = {}): {
  deps: AccountDeletionDependencies;
  read: () => UserDocument | undefined;
  enqueueCalls: {uid: string; purgeTaskName: string}[];
  revokeCalls: string[];
  countCalls: string[];
} {
  let committed = options.user === undefined ?
    activeUserDoc() :
    options.user ?? undefined;
  const enqueueCalls: {uid: string; purgeTaskName: string}[] = [];
  const revokeCalls: string[] = [];
  const countCalls: string[] = [];

  const runTransaction = async <T>(
    updateFunction: (
      transaction: FirebaseFirestore.Transaction,
    ) => Promise<T>,
  ): Promise<T> => {
    let staged = committed;
    const transaction = {
      get: async () => ({
        exists: staged !== undefined,
        data: () => staged,
      }),
      update: (
        _reference: unknown,
        patch: Partial<UserDocument>,
      ) => {
        assert.ok(staged, "update before an existing document");
        staged = {...staged, ...patch} as UserDocument;
      },
    };
    // A throw inside `updateFunction` propagates without touching
    // `committed`, matching a rolled-back Firestore transaction.
    const result = await updateFunction(
      transaction as unknown as FirebaseFirestore.Transaction,
    );
    committed = staged;
    return result;
  };

  return {
    deps: {
      countOwnedDomains: async (uid: string) => {
        countCalls.push(uid);
        return options.domainCount ?? 0;
      },
      enqueuePurgeTask: async (uid: string, purgeTaskName: string) => {
        enqueueCalls.push({uid, purgeTaskName});
      },
      revokeRefreshTokens: async (uid: string) => {
        revokeCalls.push(uid);
      },
      runTransaction,
      userDocument: () =>
        ({} as DocumentReference<UserDocument>),
    },
    read: () => committed,
    enqueueCalls,
    revokeCalls,
    countCalls,
  };
}

/**
 * Asserts that a Callable rejects with the given HttpsError contract.
 *
 * @param {Function} action Callable invocation.
 * @param {object} expected Expected code, message, and details.
 * @return {Promise<void>} Resolves when the rejection matched.
 */
async function assertRejectsWith(
  action: () => Promise<unknown>,
  expected: {code: string; message?: string; details?: unknown},
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expected.code);
    if (expected.message !== undefined) {
      assert.equal((error as HttpsError).message, expected.message);
    }
    if (expected.details !== undefined) {
      assert.deepEqual((error as HttpsError).details, expected.details);
    }
    return true;
  });
}

describe("account deletion: domain-ownership guard", () => {
  it("blocks deleteAccountWithPassword while the caller owns domains, " +
    "with the fixed failed-precondition contract", async () => {
    const {deps, read, enqueueCalls, revokeCalls} = buildDeps({
      domainCount: 3,
    });

    await assertRejectsWith(
      () => handleDeleteAccountWithPassword(callableRequest(UID), deps),
      {
        code: "failed-precondition",
        message: DOMAINS_OWNED_MESSAGE,
        details: {reason: "domains_owned", count: 3},
      },
    );

    assert.equal(read()?.status, USER_STATUS.ACTIVE, "no state change");
    assert.deepEqual(enqueueCalls, [], "no purge task may be enqueued");
    assert.deepEqual(revokeCalls, [], "no tokens may be revoked");
  });

  it("blocks deleteAccountWithGoogle while the caller owns domains, " +
    "with the fixed failed-precondition contract", async () => {
    const {deps, read, enqueueCalls, revokeCalls} = buildDeps({
      domainCount: 1,
      user: activeUserDoc(AUTH_PROVIDER.GOOGLE),
    });

    await assertRejectsWith(
      () => handleDeleteAccountWithGoogle(callableRequest(UID), deps),
      {
        code: "failed-precondition",
        message: DOMAINS_OWNED_MESSAGE,
        details: {reason: "domains_owned", count: 1},
      },
    );

    assert.equal(read()?.status, USER_STATUS.ACTIVE, "no state change");
    assert.deepEqual(enqueueCalls, [], "no purge task may be enqueued");
    assert.deepEqual(revokeCalls, [], "no tokens may be revoked");
  });

  it("allows deleteAccountWithPassword through once the domain count " +
    "is zero", async () => {
    const {deps, read, enqueueCalls, revokeCalls, countCalls} = buildDeps({
      domainCount: 0,
    });

    const result = await handleDeleteAccountWithPassword(
      callableRequest(UID),
      deps,
    );

    assert.equal(result.status, USER_STATUS.PENDING_DELETION);
    assert.equal(read()?.status, USER_STATUS.PENDING_DELETION);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].uid, UID);
    assert.deepEqual(revokeCalls, [UID]);
    assert.deepEqual(countCalls, [UID]);
  });

  it("allows deleteAccountWithGoogle through once the domain count " +
    "is zero", async () => {
    const {deps, read, enqueueCalls} = buildDeps({
      domainCount: 0,
      user: activeUserDoc(AUTH_PROVIDER.GOOGLE),
    });

    const result = await handleDeleteAccountWithGoogle(
      callableRequest(UID),
      deps,
    );

    assert.equal(result.status, USER_STATUS.PENDING_DELETION);
    assert.equal(read()?.status, USER_STATUS.PENDING_DELETION);
    assert.equal(enqueueCalls.length, 1);
  });

  it("checks domain ownership only after the provider check, so a " +
    "provider mismatch still reports permission-denied even while " +
    "domains are owned", async () => {
    const {deps, enqueueCalls} = buildDeps({
      domainCount: 5,
      user: activeUserDoc(AUTH_PROVIDER.PASSWORD),
    });

    // The caller authenticated with Google, but the stored account is a
    // password account - requesting deletion through the Google entry
    // point must still fail on the provider mismatch, not the domain
    // guard, and the message/code must stay the pre-existing one.
    await assertRejectsWith(
      () => handleDeleteAccountWithGoogle(callableRequest(UID), deps),
      {code: "permission-denied"},
    );
    assert.deepEqual(enqueueCalls, []);
  });
});

/** One canned `domains` mirror row `fakeDomainsTransaction` answers with. */
interface FakeDomainMirrorRow {
  status: string[];
  lifecycle?: unknown;
}

/**
 * Builds a fake `transaction.get()` that answers a canned set of `domains`
 * mirror rows, regardless of the actual Query object
 * `countOwnedDomainsInTransaction` builds and passes in - this test targets
 * the counting/filtering logic, not Firestore's own query engine.
 *
 * @param {ReadonlyArray<FakeDomainMirrorRow>} rows Mirror documents to
 *   answer with.
 * @return {FirebaseFirestore.Transaction} Fake transaction.
 */
function fakeDomainsTransaction(
  rows: ReadonlyArray<FakeDomainMirrorRow>,
): FirebaseFirestore.Transaction {
  return {
    get: async () => ({
      docs: rows.map((row) => ({data: () => row})),
    }),
  } as unknown as FirebaseFirestore.Transaction;
}

describe("countOwnedDomainsInTransaction: lifecycle exclusion", () => {
  it("counts zero when every mirror is gone (transferred out or " +
    "permanently deleted), including one predating the lifecycle field",
  async () => {
    const transaction = fakeDomainsTransaction([
      {status: ["gone"], lifecycle: "gone"},
      // No stored `lifecycle`: falls back to the `status` array, exactly
      // like `deriveDomainLifecycle`/`toDomainListItem` do for a mirror
      // written before the field existed.
      {status: ["gone"], lifecycle: undefined},
    ]);

    assert.equal(await countOwnedDomainsInTransaction(UID, transaction), 0);
  });

  it("still counts active and pendingDelete mirrors, excluding only the " +
    "gone ones", async () => {
    const transaction = fakeDomainsTransaction([
      {status: ["ok"], lifecycle: "active"},
      {status: ["pendingDelete"], lifecycle: "pendingDelete"},
      {status: ["gone"], lifecycle: "gone"},
    ]);

    assert.equal(await countOwnedDomainsInTransaction(UID, transaction), 2);
  });

  it("counts zero for a member with no domains at all", async () => {
    const transaction = fakeDomainsTransaction([]);

    assert.equal(await countOwnedDomainsInTransaction(UID, transaction), 0);
  });
});

/**
 * Whether a `transaction.get()` argument is the real `domains` Query built
 * by `countOwnedDomainsInTransaction` (`ownedDomainsQuery(uid).select(...)`,
 * production code, not injected) rather than the fake `users/{uid}`
 * document reference this test hands out - Query instances expose `.where`,
 * plain reference stand-ins here do not.
 *
 * @param {unknown} target Argument passed to `transaction.get()`.
 * @return {boolean} Whether `target` is a Firestore-style Query.
 */
function isFirestoreQuery(target: unknown): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    typeof (target as {where?: unknown}).where === "function"
  );
}

/**
 * Builds `AccountDeletionDependencies` wired to the REAL
 * `countOwnedDomainsInTransaction` (not a stub), so these tests exercise the
 * production count-and-filter logic end to end through
 * `handleDeleteAccountWithPassword`/`handleDeleteAccountWithGoogle`, on top
 * of a fake `users/{uid}` slot and canned `domains` mirror rows.
 *
 * @param {UserDocument | undefined} user Seed of `users/{uid}`.
 * @param {ReadonlyArray<FakeDomainMirrorRow>} domainRows Canned `domains`
 *   mirror rows the real query is answered with.
 * @return {object} Dependencies and a reader for the stored user document.
 */
function buildRealCountDeps(
  user: UserDocument | undefined,
  domainRows: ReadonlyArray<FakeDomainMirrorRow>,
): {deps: AccountDeletionDependencies; read: () => UserDocument | undefined} {
  let committed = user;
  const userDocRef = {} as DocumentReference<UserDocument>;

  const runTransaction = async <T>(
    updateFunction: (
      transaction: FirebaseFirestore.Transaction,
    ) => Promise<T>,
  ): Promise<T> => {
    let staged = committed;
    const transaction = {
      get: async (target: unknown) => {
        if (isFirestoreQuery(target)) {
          return {docs: domainRows.map((row) => ({data: () => row}))};
        }
        return {exists: staged !== undefined, data: () => staged};
      },
      update: (_reference: unknown, patch: Partial<UserDocument>) => {
        assert.ok(staged, "update before an existing document");
        staged = {...staged, ...patch} as UserDocument;
      },
    };
    const result = await updateFunction(
      transaction as unknown as FirebaseFirestore.Transaction,
    );
    committed = staged;
    return result;
  };

  return {
    deps: {
      countOwnedDomains: countOwnedDomainsInTransaction,
      enqueuePurgeTask: async () => undefined,
      revokeRefreshTokens: async () => undefined,
      runTransaction,
      userDocument: () => userDocRef,
    },
    read: () => committed,
  };
}

describe("handleDeleteAccountWithPassword: end to end with the real " +
  "countOwnedDomainsInTransaction", () => {
  it("allows deletion when every owned domain mirror is gone", async () => {
    const {deps, read} = buildRealCountDeps(activeUserDoc(), [
      {status: ["gone"], lifecycle: "gone"},
      {status: ["gone"], lifecycle: undefined},
    ]);

    const result = await handleDeleteAccountWithPassword(
      callableRequest(UID),
      deps,
    );

    assert.equal(result.status, USER_STATUS.PENDING_DELETION);
    assert.equal(read()?.status, USER_STATUS.PENDING_DELETION);
  });

  it("blocks deletion, reporting the count of non-gone mirrors only, " +
    "when domains are mixed", async () => {
    const {deps, read} = buildRealCountDeps(activeUserDoc(), [
      {status: ["ok"], lifecycle: "active"},
      {status: ["pendingDelete"], lifecycle: "pendingDelete"},
      {status: ["gone"], lifecycle: "gone"},
      {status: ["gone"], lifecycle: "gone"},
    ]);

    await assertRejectsWith(
      () => handleDeleteAccountWithPassword(callableRequest(UID), deps),
      {
        code: "failed-precondition",
        message: DOMAINS_OWNED_MESSAGE,
        // 4 mirrors total, but only the 2 non-gone ones count.
        details: {reason: "domains_owned", count: 2},
      },
    );
    assert.equal(read()?.status, USER_STATUS.ACTIVE, "no state change");
  });
});
