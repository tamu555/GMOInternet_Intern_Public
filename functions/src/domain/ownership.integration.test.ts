import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {before, describe, it} from "node:test";

import {COLLECTIONS, db} from "../config/firebase.js";
import type {RegistryClient} from "../bridge/registryClient.js";
import type {DomainInfo} from "../bridge/types.js";
import {assertOwnsDomain} from "./ownership.js";
import {
  beginMutation,
  markMutationDispatching,
  markRegistryAccepted,
  MutationConflictError,
  prepareMutation,
  reconcileDomainMirror,
  type MutationLease,
} from "./updateMirrors.js";

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for integration tests.",
  );
});

/** A fake RegistryClient plus a counter for how often it was called. */
interface FakeRegistryClient {
  client: RegistryClient;
  calls: () => number;
}

/**
 * Builds a fake RegistryClient whose `infoDomain` answers with a fixed
 * `DomainInfo`, counting how many times it was called so tests can assert a
 * replay never re-hits the registry.
 *
 * @param {DomainInfo} response `info` response to answer with.
 * @return {FakeRegistryClient} Fake client and a call-count accessor.
 */
function fakeRegistryClient(response: DomainInfo): FakeRegistryClient {
  let count = 0;
  const client: Partial<RegistryClient> = {
    registry: response.registry,
    async infoDomain() {
      count += 1;
      return response;
    },
  };
  return {client: client as RegistryClient, calls: () => count};
}

/**
 * Seeds a `ready` domain mirror document owned by `uid`.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Canonical domain name.
 * @return {Promise<void>} Resolves once written.
 */
async function seedReadyDomain(uid: string, name: string): Promise<void> {
  await db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${name}`)
    .set({
      uid,
      name,
      registry: "kitaqsign",
      nameservers: ["ns1.example.com"],
      status: [],
      rgpStatus: [],
      registrant: "U000001",
      contacts: {},
      crDate: "2026-01-01T00:00:00Z",
      syncState: "ready",
    });
}

/**
 * Deletes a domain mirror document and its `operations` subcollection.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Canonical domain name.
 * @return {Promise<void>} Resolves once cleanup completes.
 */
async function cleanupDomain(uid: string, name: string): Promise<void> {
  const ref = db().collection(COLLECTIONS.domains).doc(`${uid}__${name}`);
  const operations = await ref.collection("operations").listDocuments();
  await Promise.all(operations.map((op) => op.delete()));
  await ref.delete();
}

/**
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Canonical domain name.
 * @return {Promise<Record<string, unknown> | undefined>} Raw domain doc data.
 */
async function readDomain(
  uid: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${name}`)
    .get();
  return snap.data();
}

describe("beginMutation concurrency", () => {
  it("lets only one of two simultaneous reservations win", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "concurrent.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const [a, b] = await Promise.allSettled([
        beginMutation(owned, `op-a-${randomUUID()}`, "domain:update", "hash-a"),
        beginMutation(owned, `op-b-${randomUUID()}`, "domain:update", "hash-b"),
      ]);

      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejected = [a, b].filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);

      const rejection = rejected[0] as PromiseRejectedResult;
      assert.ok(rejection.reason instanceof MutationConflictError);
      assert.equal(
        (rejection.reason as MutationConflictError).reason,
        "resource_not_ready",
      );

      const stored = await readDomain(uid, name);
      assert.equal(stored?.syncState, "updating");
    } finally {
      await cleanupDomain(uid, name);
    }
  });

  it("rejects the same operationId reused with a different hash", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "hash-mismatch.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const operationId = `op-${randomUUID()}`;
      await beginMutation(owned, operationId, "domain:update", "hash-1");

      await assert.rejects(
        beginMutation(owned, operationId, "domain:update", "hash-2"),
        (error: unknown) => {
          assert.ok(error instanceof MutationConflictError);
          assert.equal(
            (error as MutationConflictError).reason,
            "hash_mismatch",
          );
          return true;
        },
      );
    } finally {
      await cleanupDomain(uid, name);
    }
  });
});

/**
 * Drives a lease from `reserved` through `registryAccepted`, ready for
 * `reconcileDomainMirror`.
 *
 * @param {MutationLease} lease Freshly reserved lease.
 * @param {Record<string, unknown>} before Before projection to store.
 * @param {Record<string, unknown>} expected Expected projection to store.
 * @return {Promise<void>} Resolves once the lease is ready to reconcile.
 */
async function advanceToRegistryAccepted(
  lease: MutationLease,
  before: Record<string, unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  await prepareMutation(lease, before, expected, "TEST-CLTRID");
  await markMutationDispatching(lease);
  await markRegistryAccepted(lease);
}

describe("state transitions", () => {
  it("moves ready -> updating -> ready when the mutation applied", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "applied.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const lease = await beginMutation(
        owned,
        `op-${randomUUID()}`,
        "domain:update",
        "hash-applied",
      );

      const before = {nameservers: ["ns1.example.com"]};
      const expected = {nameservers: ["ns1.example.com", "ns2.example.com"]};
      await advanceToRegistryAccepted(lease, before, expected);

      const midFlight = await readDomain(uid, name);
      assert.equal(midFlight?.syncState, "updating");

      const {client} = fakeRegistryClient({
        domain: name,
        registry: "kitaqsign",
        status: [],
        registrant: "U000001",
        contacts: {},
        nameservers: ["ns1.example.com", "ns2.example.com"],
        crDate: "2026-01-01T00:00:00Z",
        rgpStatus: [],
      });

      const decision = await reconcileDomainMirror(lease, client);
      assert.equal(decision, "applied");

      const final = await readDomain(uid, name);
      assert.equal(final?.syncState, "ready");
      assert.equal(final?.activeOperationId, undefined);
      assert.deepEqual(final?.nameservers, [
        "ns1.example.com",
        "ns2.example.com",
      ]);
    } finally {
      await cleanupDomain(uid, name);
    }
  });

  it("moves updating -> reconciliationRequired on ambiguous info", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "indeterminate.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const lease = await beginMutation(
        owned,
        `op-${randomUUID()}`,
        "domain:update",
        "hash-indeterminate",
      );

      const before = {nameservers: ["ns1.example.com"]};
      const expected = {nameservers: ["ns1.example.com", "ns2.example.com"]};
      await advanceToRegistryAccepted(lease, before, expected);

      const {client} = fakeRegistryClient({
        domain: name,
        registry: "kitaqsign",
        status: [],
        registrant: "U000001",
        contacts: {},
        // Neither the before nor the expected set: transport ambiguity.
        nameservers: ["ns9.unexpected.example.com"],
        crDate: "2026-01-01T00:00:00Z",
        rgpStatus: [],
      });

      const decision = await reconcileDomainMirror(lease, client);
      assert.equal(decision, "indeterminate");

      const final = await readDomain(uid, name);
      assert.equal(final?.syncState, "reconciliationRequired");
      // The operation lock is deliberately kept so no new mutation can start
      // against a resource that needs manual investigation.
      assert.ok(typeof final?.activeOperationId === "string");
    } finally {
      await cleanupDomain(uid, name);
    }
  });

  it("reverts to ready when info still matches the before state", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "notapplied.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const lease = await beginMutation(
        owned,
        `op-${randomUUID()}`,
        "domain:update",
        "hash-notapplied",
      );

      const before = {nameservers: ["ns1.example.com"]};
      const expected = {nameservers: ["ns1.example.com", "ns2.example.com"]};
      await advanceToRegistryAccepted(lease, before, expected);

      const {client} = fakeRegistryClient({
        domain: name,
        registry: "kitaqsign",
        status: [],
        registrant: "U000001",
        contacts: {},
        nameservers: ["ns1.example.com"],
        crDate: "2026-01-01T00:00:00Z",
        rgpStatus: [],
      });

      const decision = await reconcileDomainMirror(lease, client);
      assert.equal(decision, "notApplied");

      const final = await readDomain(uid, name);
      assert.equal(final?.syncState, "ready");
      assert.equal(final?.activeOperationId, undefined);
    } finally {
      await cleanupDomain(uid, name);
    }
  });
});

describe("reconciliation CAS behaviour", () => {
  it("does not re-call the registry once terminated", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "replay.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const lease = await beginMutation(
        owned,
        `op-${randomUUID()}`,
        "domain:update",
        "hash-replay",
      );

      const before = {nameservers: ["ns1.example.com"]};
      const expected = {nameservers: ["ns1.example.com", "ns2.example.com"]};
      await advanceToRegistryAccepted(lease, before, expected);

      const {client, calls} = fakeRegistryClient({
        domain: name,
        registry: "kitaqsign",
        status: [],
        registrant: "U000001",
        contacts: {},
        nameservers: ["ns1.example.com", "ns2.example.com"],
        crDate: "2026-01-01T00:00:00Z",
        rgpStatus: [],
      });

      const first = await reconcileDomainMirror(lease, client);
      assert.equal(first, "applied");
      assert.equal(calls(), 1);

      // A resumed lease for the same operationId, as `beginMutation` would
      // return on replay.
      const resumedLease = await beginMutation(
        owned,
        lease.operationId,
        "domain:update",
        "hash-replay",
      );
      assert.equal(resumedLease.resumed, true);

      const second = await reconcileDomainMirror(resumedLease, client);
      assert.equal(second, "applied");
      // The registry was not asked again: the cached terminal result was
      // returned directly.
      assert.equal(calls(), 1);
    } finally {
      await cleanupDomain(uid, name);
    }
  });

  it("does not let a duplicate finalize overwrite the outcome", async () => {
    const uid = `own-${randomUUID()}`;
    const name = "duplicate-finalize.example.com";
    await seedReadyDomain(uid, name);
    try {
      const owned = await assertOwnsDomain(uid, name);
      const lease = await beginMutation(
        owned,
        `op-${randomUUID()}`,
        "domain:update",
        "hash-duplicate",
      );

      const before = {nameservers: ["ns1.example.com"]};
      const expected = {nameservers: ["ns1.example.com", "ns2.example.com"]};
      await advanceToRegistryAccepted(lease, before, expected);

      const {client} = fakeRegistryClient({
        domain: name,
        registry: "kitaqsign",
        status: [],
        registrant: "U000001",
        contacts: {},
        nameservers: ["ns1.example.com", "ns2.example.com"],
        crDate: "2026-01-01T00:00:00Z",
        rgpStatus: [],
      });

      // Two duplicate handler invocations racing on the same lease.
      const [first, second] = await Promise.all([
        reconcileDomainMirror(lease, client),
        reconcileDomainMirror(lease, client),
      ]);
      assert.equal(first, "applied");
      assert.equal(second, "applied");

      const opSnap = await db()
        .collection(COLLECTIONS.domains)
        .doc(`${uid}__${name}`)
        .collection("operations")
        .doc(lease.operationId)
        .get();
      assert.equal(opSnap.data()?.phase, "succeeded");
      assert.equal(opSnap.data()?.beforeProjection, undefined);
      assert.equal(opSnap.data()?.expectedProjection, undefined);

      const final = await readDomain(uid, name);
      assert.equal(final?.syncState, "ready");
    } finally {
      await cleanupDomain(uid, name);
    }
  });
});
