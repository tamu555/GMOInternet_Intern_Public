/**
 * Callable-contract tests for `listDomains` and `getDomainInfo`.
 *
 * Every dependency here is substituted, so these run without a live
 * Firestore or EPP connection. What they cover is the contract itself: auth,
 * the active-member gate, input validation ordering, and — the feature's
 * required security case — that a nonexistent domain and a domain owned by
 * another member are indistinguishable from the outside.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {RegistryError} from "../bridge/errors";
import type {RegistryErrorKind} from "../bridge/errors";
import type {DomainListItem} from "../domain/domainRepository";
import type {GetDomainInfoResponse} from "../domain/getDomainInfo";
import {handleGetDomainInfo} from "./getDomainInfo";
import type {
  GetDomainInfoData,
  GetDomainInfoHandlerDependencies,
} from "./getDomainInfo";
import {handleListDomains} from "./listDomains";
import type {ListDomainsHandlerDependencies} from "./listDomains";

const UID = "member-uid-1";

const SAMPLE_LIST_ITEM: DomainListItem = {
  name: "example.jp",
  tld: "jp",
  registry: "kitaqnic",
  status: ["ok"],
  rgpStatus: [],
  exDate: "2027-01-01T00:00:00Z",
  autoRenew: true,
  restorableUntil: null,
  autoRenewCancelableUntil: null,
  lifecycle: "active",
  goneReason: null,
  restoreFeeYen: 8000,
};

const SAMPLE_INFO: GetDomainInfoResponse = {
  domain: "example.jp",
  registry: "kitaqnic",
  status: ["ok"],
  registrant: "contact-1",
  contacts: {ADMIN: "contact-1", TECH: "contact-1"},
  nameservers: ["ns1.example.jp"],
  crDate: "2026-01-01T00:00:00Z",
  upDate: null,
  exDate: "2027-01-01T00:00:00Z",
  trDate: null,
  rgpStatus: [],
};

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
 * @param {object} expected Expected code, message and details.
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

/**
 * Builds a bridge-layer `RegistryError` fixture for error-mapping tests.
 *
 * @param {RegistryErrorKind} kind Failure classification.
 * @return {RegistryError} A minimal but valid fixture.
 */
function registryError(kind: RegistryErrorKind): RegistryError {
  return new RegistryError({
    kind,
    registry: "kitaqnic",
    command: "domain:info",
    message: `registry failure: ${kind}`,
    clTRID: "APP-INFO-TEST",
  });
}

/** Counts invocations of a zero/one-argument stub. */
class CallCounter {
  count = 0;
}

describe("handleListDomains", () => {
  it("rejects unauthenticated requests", async () => {
    await assertRejectsWith(
      () => handleListDomains(callableRequest({})),
      {code: "unauthenticated", message: "ログインが必要です。"},
    );
  });

  it("rejects a non-active member without a repository call", async () => {
    const listCalls = new CallCounter();
    const deps: ListDomainsHandlerDependencies = {
      isActiveMember: async () => false,
      listOwnedDomains: async () => {
        listCalls.count += 1;
        return [SAMPLE_LIST_ITEM];
      },
    };

    await assertRejectsWith(
      () => handleListDomains(callableRequest({}, UID), deps),
      {code: "permission-denied"},
    );
    assert.equal(listCalls.count, 0);
  });

  it("returns an empty list for a member with no domains", async () => {
    const deps: ListDomainsHandlerDependencies = {
      isActiveMember: async () => true,
      listOwnedDomains: async () => [],
    };

    const result = await handleListDomains(callableRequest({}, UID), deps);
    assert.deepEqual(result, {domains: []});
  });

  it("returns the caller's own domains on success", async () => {
    const deps: ListDomainsHandlerDependencies = {
      isActiveMember: async () => true,
      listOwnedDomains: async (uid) => {
        assert.equal(uid, UID);
        return [SAMPLE_LIST_ITEM];
      },
    };

    const result = await handleListDomains(callableRequest({}, UID), deps);
    assert.deepEqual(result, {domains: [SAMPLE_LIST_ITEM]});
  });
});

describe("handleGetDomainInfo", () => {
  const validRequest = (uid?: string) =>
    callableRequest<GetDomainInfoData>({domainName: "example.jp"}, uid);

  it("rejects unauthenticated requests", async () => {
    await assertRejectsWith(
      () => handleGetDomainInfo(validRequest()),
      {code: "unauthenticated", message: "ログインが必要です。"},
    );
  });

  it("rejects a non-active member without calling the use case", async () => {
    const infoCalls = new CallCounter();
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => false,
      getLiveDomainInfo: async () => {
        infoCalls.count += 1;
        return SAMPLE_INFO;
      },
    };

    await assertRejectsWith(
      () => handleGetDomainInfo(validRequest(UID), deps),
      {code: "permission-denied"},
    );
    assert.equal(infoCalls.count, 0);
  });

  it("runs the active-member gate before input validation", async () => {
    const infoCalls = new CallCounter();
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => false,
      getLiveDomainInfo: async () => {
        infoCalls.count += 1;
        return SAMPLE_INFO;
      },
    };
    // An invalid domainName would normally fail validation first; the
    // active-member gate must still win so a non-active member never learns
    // whether their input would otherwise have validated.
    const request = callableRequest<GetDomainInfoData>(
      {domainName: ""},
      UID,
    );

    await assertRejectsWith(
      () => handleGetDomainInfo(request, deps),
      {code: "permission-denied"},
    );
    assert.equal(infoCalls.count, 0);
  });

  it("rejects an invalid domainName with invalid-argument", async () => {
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => true,
      getLiveDomainInfo: async () => SAMPLE_INFO,
    };
    const request = callableRequest<GetDomainInfoData>(
      {domainName: ""},
      UID,
    );

    await assertRejectsWith(
      () => handleGetDomainInfo(request, deps),
      {code: "invalid-argument"},
    );
  });

  it("returns the live domain detail on success", async () => {
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => true,
      getLiveDomainInfo: async (uid, normalizedName) => {
        assert.equal(uid, UID);
        assert.equal(normalizedName, "example.jp");
        return SAMPLE_INFO;
      },
    };

    const result = await handleGetDomainInfo(validRequest(UID), deps);
    assert.deepEqual(result, SAMPLE_INFO);
  });

  it(
    "maps a nonexistent domain and an other-member-owned domain to an " +
      "identical not-found contract",
    async () => {
      const nonexistentDeps: GetDomainInfoHandlerDependencies = {
        isActiveMember: async () => true,
        // Fixture: no mirror doc exists for this key at all.
        getLiveDomainInfo: async () => null,
      };
      const otherOwnerDeps: GetDomainInfoHandlerDependencies = {
        isActiveMember: async () => true,
        // Fixture: the mirror doc exists but is owned by a different uid;
        // the repository layer already collapsed that to `null`.
        getLiveDomainInfo: async () => null,
      };

      const nonexistentError = await assertRejectsWith(
        () => handleGetDomainInfo(validRequest(UID), nonexistentDeps),
        {code: "not-found"},
      );
      const otherOwnerError = await assertRejectsWith(
        () => handleGetDomainInfo(validRequest(UID), otherOwnerDeps),
        {code: "not-found"},
      );

      assert.equal(nonexistentError.code, otherOwnerError.code);
      assert.equal(nonexistentError.message, otherOwnerError.message);
      assert.deepEqual(nonexistentError.details, otherOwnerError.details);
      assert.equal(nonexistentError.message, "対象がレジストリに見つかりませんでした。");
      assert.equal(nonexistentError.details, undefined);
    },
  );

  it("maps RegistryError.objectNotFound to not-found", async () => {
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => true,
      getLiveDomainInfo: async () => {
        throw registryError("objectNotFound");
      },
    };

    await assertRejectsWith(
      () => handleGetDomainInfo(validRequest(UID), deps),
      {
        code: "not-found",
        message: "対象がレジストリに見つかりませんでした。",
      },
    );
  });

  it("maps RegistryError.transport to unavailable", async () => {
    const deps: GetDomainInfoHandlerDependencies = {
      isActiveMember: async () => true,
      getLiveDomainInfo: async () => {
        throw registryError("transport");
      },
    };

    await assertRejectsWith(
      () => handleGetDomainInfo(validRequest(UID), deps),
      {code: "unavailable"},
    );
  });
});
