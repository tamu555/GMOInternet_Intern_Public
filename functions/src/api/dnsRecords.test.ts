/**
 * Callable-contract tests for `listDnsRecords` / `saveDnsRecords` /
 * `resolveDns`. Every dependency is substituted, so these run without a live
 * Firestore. Covered: auth, input validation and its ordering ahead of any
 * Firestore work, the ownership gate (FIG.11: foreign domains are
 * `permission-denied`), the full-replacement echo, and the resolver's
 * "empty is not an error" contract.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import type {DnsRecord} from "../domain/dnsZones";
import {OwnershipError} from "../domain/ownership";
import {
  handleListDnsRecords,
  handleResolveDns,
  handleSaveDnsRecords,
} from "./dnsRecords";
import type {DnsRecordsDependencies} from "./dnsRecords";

const UID = "member-uid-1";

const SAMPLE_RECORD: DnsRecord = {
  type: "A",
  name: "www",
  value: "203.0.113.1",
  ttl: 300,
  priority: null,
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

/** Call log recorded by {@link fakeDependencies}. */
interface DependencyCalls {
  owns: Array<{uid: string; domainName: string}>;
  read: Array<{uid: string; domainName: string}>;
  replace: Array<{uid: string; domainName: string; records: DnsRecord[]}>;
  resolve: Array<{fqdn: string; type: string}>;
}

/**
 * Builds recording fake dependencies.
 *
 * @param {Partial<DnsRecordsDependencies>} overrides Behaviour overrides.
 * @return {{deps: DnsRecordsDependencies, calls: DependencyCalls}} The fake
 *   dependency set and its call log.
 */
function fakeDependencies(
  overrides: Partial<DnsRecordsDependencies> = {},
): {deps: DnsRecordsDependencies; calls: DependencyCalls} {
  const calls: DependencyCalls = {owns: [], read: [], replace: [], resolve: []};
  const deps: DnsRecordsDependencies = {
    assertOwnsDomain: async (uid, domainName) => {
      calls.owns.push({uid, domainName});
    },
    readZoneRecords: async (uid, domainName) => {
      calls.read.push({uid, domainName});
      return [SAMPLE_RECORD];
    },
    replaceZoneRecords: async (uid, domainName, records) => {
      calls.replace.push({uid, domainName, records});
      return records;
    },
    resolveZoneRecords: async (fqdn, type) => {
      calls.resolve.push({fqdn, type});
      return [];
    },
    ...overrides,
  };
  return {deps, calls};
}

/**
 * Ownership failure the way `assertOwnsDomain` reports it.
 *
 * @return {OwnershipError} The not-owned fixture.
 */
function notOwned(): OwnershipError {
  return new OwnershipError(
    "domain",
    "not_owned",
    "対象のドメインが見つからないか、このアカウントの所有物ではありません。",
  );
}

describe("handleListDnsRecords", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies();
    await assertRejectsWith(
      () => handleListDnsRecords(
        callableRequest({domainName: "example.com"}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects a non-string domainName before touching Firestore", async () => {
    const {deps, calls} = fakeDependencies();
    await assertRejectsWith(
      () => handleListDnsRecords(callableRequest({domainName: 1}, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(calls.owns.length, 0);
  });

  it("maps an ownership failure to permission-denied", async () => {
    const {deps} = fakeDependencies({
      assertOwnsDomain: async () => {
        throw notOwned();
      },
    });
    await assertRejectsWith(
      () => handleListDnsRecords(
        callableRequest({domainName: "example.com"}, UID), deps),
      {code: "permission-denied"},
    );
  });

  it("normalises the domain name and returns the zone", async () => {
    const {deps, calls} = fakeDependencies();
    const result = await handleListDnsRecords(
      callableRequest({domainName: " Example.COM. "}, UID),
      deps,
    );
    assert.deepEqual(result, {records: [SAMPLE_RECORD]});
    assert.deepEqual(calls.owns, [{uid: UID, domainName: "example.com"}]);
    assert.deepEqual(calls.read, [{uid: UID, domainName: "example.com"}]);
  });
});

describe("handleSaveDnsRecords", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies();
    await assertRejectsWith(
      () => handleSaveDnsRecords(
        callableRequest({domainName: "example.com", records: []}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects malformed records before the ownership read", async () => {
    const {deps, calls} = fakeDependencies();
    await assertRejectsWith(
      () => handleSaveDnsRecords(
        callableRequest({
          domainName: "example.com",
          records: [{type: "SRV", name: "www", value: "x"}],
        }, UID),
        deps,
      ),
      {code: "invalid-argument"},
    );
    assert.equal(calls.owns.length, 0);
    assert.equal(calls.replace.length, 0);
  });

  it("does not write when ownership fails", async () => {
    const {deps, calls} = fakeDependencies({
      assertOwnsDomain: async () => {
        throw notOwned();
      },
    });
    await assertRejectsWith(
      () => handleSaveDnsRecords(
        callableRequest({
          domainName: "example.com",
          records: [{type: "A", name: "www", value: "203.0.113.1"}],
        }, UID),
        deps,
      ),
      {code: "permission-denied"},
    );
    assert.equal(calls.replace.length, 0);
  });

  it("stores the normalised set and echoes it back", async () => {
    const {deps, calls} = fakeDependencies();
    const result = await handleSaveDnsRecords(
      callableRequest({
        domainName: "Example.com",
        records: [
          {type: "A", name: "", value: "203.0.113.1"},
          {type: "MX", name: "@", value: "mx.example.net", priority: 10},
        ],
      }, UID),
      deps,
    );
    const expected: DnsRecord[] = [
      {type: "A", name: "@", value: "203.0.113.1", ttl: null, priority: null},
      {type: "MX", name: "@", value: "mx.example.net", ttl: null,
        priority: 10},
    ];
    assert.deepEqual(result, {records: expected});
    assert.deepEqual(calls.replace, [
      {uid: UID, domainName: "example.com", records: expected},
    ]);
  });

  it("accepts an empty array (deleting every record)", async () => {
    const {deps, calls} = fakeDependencies();
    const result = await handleSaveDnsRecords(
      callableRequest({domainName: "example.com", records: []}, UID),
      deps,
    );
    assert.deepEqual(result, {records: []});
    assert.equal(calls.replace.length, 1);
  });
});

describe("handleResolveDns", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies();
    await assertRejectsWith(
      () => handleResolveDns(
        callableRequest({name: "www.example.com", type: "A"}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects an unknown record type", async () => {
    const {deps, calls} = fakeDependencies();
    await assertRejectsWith(
      () => handleResolveDns(
        callableRequest({name: "www.example.com", type: "SRV"}, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(calls.resolve.length, 0);
  });

  it("rejects a non-FQDN name", async () => {
    const {deps} = fakeDependencies();
    await assertRejectsWith(
      () => handleResolveDns(
        callableRequest({name: "localhost", type: "A"}, UID), deps),
      {code: "invalid-argument"},
    );
  });

  it("answers empty without error and never checks ownership", async () => {
    const {deps, calls} = fakeDependencies();
    const result = await handleResolveDns(
      callableRequest({name: "WWW.Example.com.", type: "A"}, UID),
      deps,
    );
    assert.deepEqual(result, {records: []});
    assert.deepEqual(calls.resolve, [{fqdn: "www.example.com", type: "A"}]);
    assert.equal(calls.owns.length, 0);
  });
});
