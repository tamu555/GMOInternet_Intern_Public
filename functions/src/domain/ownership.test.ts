import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {Firestore} from "firebase-admin/firestore";
import {
  assertOwnsContact,
  assertOwnsDomain,
  assertOwnsHost,
  OwnershipError,
} from "./ownership.js";

/**
 * Minimal in-memory stand-in for the slice of the Firestore Admin SDK these
 * helpers use (`firestore.collection(name).doc(id).get()`).
 *
 * @param {Record<string, Record<string, unknown> | undefined>} docs Documents
 *   keyed by `"{collection}/{docId}"`; an absent/undefined entry behaves like
 *   a non-existent document.
 * @return {Firestore} Fake Firestore, cast to the real interface.
 */
function fakeFirestore(
  docs: Record<string, Record<string, unknown> | undefined>,
): Firestore {
  const firestore = {
    collection(name: string) {
      return {
        doc(id: string) {
          const key = `${name}/${id}`;
          return {
            async get() {
              const data = docs[key];
              return {exists: data !== undefined, data: () => data};
            },
          };
        },
      };
    },
  };
  return firestore as unknown as Firestore;
}

/**
 * @param {Promise<unknown>} promise Assertion target.
 * @return {Promise<OwnershipError>} The rejected `OwnershipError`.
 */
async function assertOwnershipError(
  promise: Promise<unknown>,
): Promise<OwnershipError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OwnershipError);
    return error;
  }
  throw new Error("expected promise to reject with an OwnershipError");
}

describe("assertOwnsDomain", () => {
  it("accepts a ready, caller-owned domain", async () => {
    const firestore = fakeFirestore({
      "domains/uid1__example.com": {
        uid: "uid1",
        name: "example.com",
        registry: "kitaqsign",
        syncState: "ready",
      },
    });
    const owned = await assertOwnsDomain(
      "uid1",
      "example.com",
      firestore,
    );
    assert.deepEqual(owned, {
      kind: "domain",
      ref: owned.ref,
      uid: "uid1",
      name: "example.com",
      registry: "kitaqsign",
    });
  });

  it("treats a legacy domain with no syncState field as ready", async () => {
    const firestore = fakeFirestore({
      "domains/uid1__legacy.com": {
        uid: "uid1",
        name: "legacy.com",
        registry: "kitaqnic",
      },
    });
    const owned = await assertOwnsDomain("uid1", "legacy.com", firestore);
    assert.equal(owned.registry, "kitaqnic");
  });

  it("produces the identical error for a missing and a foreign owner",
    async () => {
      const firestore = fakeFirestore({
        "domains/uid2__taken.com": {
          uid: "someone-else",
          name: "taken.com",
          registry: "kitaqsign",
          syncState: "ready",
        },
      });

      const missing = await assertOwnershipError(
        assertOwnsDomain("uid1", "missing.com", firestore),
      );
      const foreign = await assertOwnershipError(
        assertOwnsDomain("uid1", "taken.com", firestore),
      );

      assert.equal(missing.message, foreign.message);
      assert.equal(missing.reason, foreign.reason);
      assert.equal(missing.reason, "not_owned");
      assert.equal(missing.resourceKind, "domain");
    });

  it("collapses a malformed document into the same not_owned error",
    async () => {
      const firestore = fakeFirestore({
        "domains/uid1__malformed.com": {
          uid: "uid1",
          name: "malformed.com",
          registry: "not-a-real-registry",
          syncState: "ready",
        },
      });
      const error = await assertOwnershipError(
        assertOwnsDomain("uid1", "malformed.com", firestore),
      );
      assert.equal(error.reason, "not_owned");
    });

  it("rejects a domain that is not ready as a distinct error", async () => {
    const firestore = fakeFirestore({
      "domains/uid1__updating.com": {
        uid: "uid1",
        name: "updating.com",
        registry: "kitaqsign",
        syncState: "updating",
      },
    });
    const error = await assertOwnershipError(
      assertOwnsDomain("uid1", "updating.com", firestore),
    );
    assert.equal(error.reason, "not_ready");
    assert.equal(error.resourceKind, "domain");
  });
});

describe("assertOwnsContact", () => {
  it("accepts a ready, caller-owned contact on the required registry",
    async () => {
      const firestore = fakeFirestore({
        "registryContacts/uid1__kitaqsign": {
          uid: "uid1",
          registry: "kitaqsign",
          contactId: "U000123",
          state: "ready",
        },
      });
      const owned = await assertOwnsContact(
        "uid1",
        "U000123",
        "kitaqsign",
        firestore,
      );
      assert.equal(owned.contactId, "U000123");
      assert.equal(owned.registry, "kitaqsign");
    });

  it("rejects when the required registry does not match the stored one",
    async () => {
      const firestore = fakeFirestore({
        "registryContacts/uid1__kitaqsign": {
          uid: "uid1",
          registry: "kitaqsign",
          contactId: "U000123",
          state: "ready",
        },
        // The caller only has a contact link on kitaqsign; a domain whose
        // stored registry is kitaqnic must not resolve through it.
      });
      const error = await assertOwnershipError(
        assertOwnsContact("uid1", "U000123", "kitaqnic", firestore),
      );
      assert.equal(error.reason, "not_owned");
    });

  it("produces the identical error for missing and foreign-owner contacts",
    async () => {
      const firestore = fakeFirestore({
        "registryContacts/uid2__kitaqsign": {
          uid: "someone-else",
          registry: "kitaqsign",
          contactId: "U000999",
          state: "ready",
        },
      });
      const missing = await assertOwnershipError(
        assertOwnsContact("uid1", "U000123", "kitaqsign", firestore),
      );
      const foreign = await assertOwnershipError(
        assertOwnsContact("uid2", "U000123", "kitaqsign", firestore),
      );
      assert.equal(missing.message, foreign.message);
      assert.equal(missing.reason, foreign.reason);
    });

  it("rejects a contact that has not finished being created", async () => {
    const firestore = fakeFirestore({
      "registryContacts/uid1__kitaqsign": {
        uid: "uid1",
        registry: "kitaqsign",
        contactId: "U000123",
        state: "failed",
      },
    });
    const error = await assertOwnershipError(
      assertOwnsContact("uid1", "U000123", "kitaqsign", firestore),
    );
    assert.equal(error.reason, "not_ready");
  });
});

describe("assertOwnsHost", () => {
  it("accepts a ready, caller-owned host", async () => {
    const firestore = fakeFirestore({
      "registryHosts/uid1__ns1.example.com": {
        uid: "uid1",
        name: "ns1.example.com",
        parentDomain: "example.com",
        registry: "kitaqnic",
        lifecycleState: "ready",
      },
    });
    const owned = await assertOwnsHost(
      "uid1",
      "ns1.example.com",
      firestore,
    );
    assert.equal(owned.parentDomain, "example.com");
  });

  it("produces the identical error for missing and foreign-owner hosts",
    async () => {
      const firestore = fakeFirestore({
        "registryHosts/uid2__ns1.example.com": {
          uid: "someone-else",
          name: "ns1.example.com",
          parentDomain: "example.com",
          registry: "kitaqnic",
          lifecycleState: "ready",
        },
      });
      const missing = await assertOwnershipError(
        assertOwnsHost("uid1", "ns-missing.example.com", firestore),
      );
      const foreign = await assertOwnershipError(
        assertOwnsHost("uid1", "ns1.example.com", firestore),
      );
      assert.equal(missing.message, foreign.message);
      assert.equal(missing.reason, foreign.reason);
    });

  it("rejects a host outside its creating/ready lifecycle as not_ready",
    async () => {
      const firestore = fakeFirestore({
        "registryHosts/uid1__ns1.example.com": {
          uid: "uid1",
          name: "ns1.example.com",
          parentDomain: "example.com",
          registry: "kitaqnic",
          lifecycleState: "creating",
        },
      });
      const error = await assertOwnershipError(
        assertOwnsHost("uid1", "ns1.example.com", firestore),
      );
      assert.equal(error.reason, "not_ready");
    });
});
