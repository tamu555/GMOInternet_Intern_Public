/**
 * Callable-contract tests for `updateAutoRenew`. The write dependency is
 * substituted, so these run without a live Firestore. Covered: auth, input
 * validation ordering ahead of any Firestore work, ownership-failure
 * mapping, the echo response, and the pure `pendingDelete` write guard.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {OwnershipError} from "../domain/ownership";
import {
  assertAutoRenewWritable,
  handleUpdateAutoRenew,
} from "./updateAutoRenew";
import type {UpdateAutoRenewDependencies} from "./updateAutoRenew";

const UID = "member-uid-1";

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
 * @return {Promise<HttpsError>} The rejected error, for further inspection.
 */
async function assertRejectsWith(
  action: () => Promise<unknown>,
  expected: {code: string; message?: string},
): Promise<HttpsError> {
  let captured: unknown;
  await assert.rejects(action, (error: unknown) => {
    captured = error;
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expected.code);
    if (expected.message !== undefined) {
      assert.equal((error as HttpsError).message, expected.message);
    }
    return true;
  });
  return captured as HttpsError;
}

/** One recorded write. */
interface WriteCall {
  uid: string;
  domainName: string;
  autoRenew: boolean;
}

/**
 * Builds recording fake dependencies.
 *
 * @param {Partial<UpdateAutoRenewDependencies>} overrides Behaviour
 *   overrides.
 * @return {{deps: UpdateAutoRenewDependencies, writes: WriteCall[]}} The
 *   fake dependency set and its call log.
 */
function fakeDependencies(
  overrides: Partial<UpdateAutoRenewDependencies> = {},
): {deps: UpdateAutoRenewDependencies; writes: WriteCall[]} {
  const writes: WriteCall[] = [];
  const deps: UpdateAutoRenewDependencies = {
    writeAutoRenew: async (uid, domainName, autoRenew) => {
      writes.push({uid, domainName, autoRenew});
    },
    ...overrides,
  };
  return {deps, writes};
}

describe("handleUpdateAutoRenew", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies();
    await assertRejectsWith(
      () => handleUpdateAutoRenew(
        callableRequest({domainName: "example.com", autoRenew: false}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects a non-string domainName before any write", async () => {
    const {deps, writes} = fakeDependencies();
    await assertRejectsWith(
      () => handleUpdateAutoRenew(
        callableRequest({domainName: 1, autoRenew: true}, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(writes.length, 0);
  });

  it("rejects a non-boolean autoRenew before any write", async () => {
    const {deps, writes} = fakeDependencies();
    await assertRejectsWith(
      () => handleUpdateAutoRenew(
        callableRequest({domainName: "example.com", autoRenew: "on"}, UID),
        deps),
      {code: "invalid-argument"},
    );
    assert.equal(writes.length, 0);
  });

  it("maps an ownership failure to permission-denied", async () => {
    const {deps} = fakeDependencies({
      writeAutoRenew: async () => {
        throw new OwnershipError(
          "domain",
          "not_owned",
          "対象のドメインが見つからないか、このアカウントの所有物ではありません。",
        );
      },
    });
    await assertRejectsWith(
      () => handleUpdateAutoRenew(
        callableRequest({domainName: "example.com", autoRenew: false}, UID),
        deps),
      {code: "permission-denied"},
    );
  });

  it("normalises the domain name, writes, and echoes the flag", async () => {
    const {deps, writes} = fakeDependencies();
    const result = await handleUpdateAutoRenew(
      callableRequest({domainName: " Example.COM. ", autoRenew: false}, UID),
      deps,
    );
    assert.deepEqual(result, {domainName: "example.com", autoRenew: false});
    assert.deepEqual(writes, [
      {uid: UID, domainName: "example.com", autoRenew: false},
    ]);
  });
});

describe("assertAutoRenewWritable", () => {
  it("allows a live domain and a missing status field", () => {
    assert.doesNotThrow(() => assertAutoRenewWritable(["ok"]));
    assert.doesNotThrow(() => assertAutoRenewWritable(undefined));
  });

  it("refuses a pendingDelete domain with failed-precondition", () => {
    assert.throws(
      () => assertAutoRenewWritable(["pendingDelete", "serverHold"]),
      (error: unknown) => {
        assert.ok(error instanceof HttpsError);
        assert.equal((error as HttpsError).code, "failed-precondition");
        return true;
      },
    );
  });
});
