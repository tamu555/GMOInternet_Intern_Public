import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, before, describe, it} from "node:test";

import {Timestamp} from "firebase-admin/firestore";

import {AUTH_PROVIDER, USER_STATUS} from "../auth/constants";
import {userDocument} from "../auth/firestore";
import type {UserDocument} from "../auth/types";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {
  getOwnedDomain,
  isActiveMember,
  listOwnedDomains,
} from "./domainRepository";

const domainsCollection = () => db().collection(COLLECTIONS.domains);

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for integration tests.",
  );
});

/** Every domains/{docId} field written by provisionDomain.ts's saveDomain(). */
interface DomainDocOverrides {
  uid?: unknown;
  name?: unknown;
  tld?: string;
  registry?: unknown;
  status?: unknown;
  rgpStatus?: unknown;
  exDate?: unknown;
  autoRenew?: unknown;
  nameservers?: string[];
  crDate?: string | null;
  authInfo?: string | null;
  registrant?: string | null;
  orderId?: string | null;
  /** Written by deleteOwnedDomain; absent on a domain that is still live. */
  deletedAt?: unknown;
  /**
   * Written by deleteOwnedDomain from the registry's own
   * `extension.pendingDeleteUntil`; absent when it sent none.
   */
  restorableUntil?: unknown;
}

/**
 * Writes one domains/{uid}__{name} mirror document, including the sensitive
 * fields (`authInfo`, `registrant`, `orderId`) real production data carries,
 * so the projection tests have something real to leak if they are broken.
 *
 * @param {string} docId Mirror document id.
 * @param {DomainDocOverrides} overrides Fields to set on the document.
 * @return {Promise<void>} Resolves once written.
 */
async function seedDomainDoc(
  docId: string,
  overrides: DomainDocOverrides,
): Promise<void> {
  await domainsCollection().doc(docId).set({
    uid: overrides.uid,
    name: overrides.name,
    tld: overrides.tld ?? "com",
    registry: overrides.registry ?? "kitaqsign",
    status: overrides.status ?? ["ok"],
    rgpStatus: overrides.rgpStatus ?? [],
    exDate: overrides.exDate ?? "2027-01-01T00:00:00Z",
    autoRenew: overrides.autoRenew ?? true,
    nameservers: overrides.nameservers ?? ["ns1.example.com"],
    crDate: overrides.crDate ?? "2026-01-01T00:00:00Z",
    authInfo: overrides.authInfo ?? "super-secret-passphrase",
    registrant: overrides.registrant ?? "contact-1",
    orderId: overrides.orderId ?? "order-1",
    updatedAt: Timestamp.now(),
    ...(overrides.deletedAt === undefined ?
      {} :
      {deletedAt: overrides.deletedAt}),
    ...(overrides.restorableUntil === undefined ?
      {} :
      {restorableUntil: overrides.restorableUntil}),
  });
}

/**
 * Writes one users/{uid} fixture document.
 *
 * @param {string} uid Firebase Authentication user id.
 * @param {string} status Member status to store.
 * @return {Promise<void>} Resolves once written.
 */
async function seedUser(uid: string, status: string): Promise<void> {
  const now = Timestamp.now();
  const common = {
    uid,
    email: `${uid}@example.com`,
    authProvider: AUTH_PROVIDER.PASSWORD,
    createdAt: now,
    updatedAt: now,
    deletionRequestedAt: null,
    scheduledPurgeAt: null,
    purgeTaskName: null,
  };
  // `UserDocument` is a status-discriminated union: `profile` is `null`
  // only for `pending_additional_info`, never for the other three statuses.
  const isPendingAdditionalInfo =
    status === USER_STATUS.PENDING_ADDITIONAL_INFO;
  const document = {
    ...common,
    status: status as UserDocument["status"],
    profile: isPendingAdditionalInfo ? null : {
      name: "Integration User",
      nameKana: "インテグレーションユーザー",
      phoneNumber: "090-1234-5678",
      dateOfBirth: "1990-01-01",
      gender: "no_answer" as const,
      newsletterOptIn: false,
      accountType: "individual" as const,
      business: null,
      address: {
        country: "JP" as const,
        postalCode: "123-4567",
        prefecture: "東京都",
        city: "千代田区",
        addressLine: "1-1-1",
        building: null,
      },
    },
  } as UserDocument;
  await userDocument(uid).set(document);
}

/** One test's worth of isolated fixture ids, cleaned up in `finally`. */
interface Fixture {
  uidA: string;
  uidB: string;
}

/**
 * Allocates two independent, collision-free member ids for one test.
 *
 * @return {Fixture} Fixture ids.
 */
function newFixture(): Fixture {
  const suffix = randomUUID();
  return {
    uidA: `domain-repo-a-${suffix}`,
    uidB: `domain-repo-b-${suffix}`,
  };
}

/**
 * Deletes every users/{uid} and domains/{docId} document a test may have
 * written, tolerating documents that were never created.
 *
 * @param {Fixture} fixture Fixture ids to remove.
 * @param {string[]} domainDocIds Domain mirror document ids to remove.
 * @return {Promise<void>} Resolves after best-effort cleanup.
 */
async function cleanup(
  fixture: Fixture,
  domainDocIds: string[],
): Promise<void> {
  await Promise.all([
    userDocument(fixture.uidA).delete(),
    userDocument(fixture.uidB).delete(),
    ...domainDocIds.map((docId) => domainsCollection().doc(docId).delete()),
  ]);
}

after(() => {
  // Nothing global to tear down: every test cleans up its own fixtures.
});

describe("isActiveMember", () => {
  it("returns true for an active member", async () => {
    const {uidA} = newFixture();
    await seedUser(uidA, USER_STATUS.ACTIVE);
    try {
      assert.equal(await isActiveMember(uidA), true);
    } finally {
      await userDocument(uidA).delete();
    }
  });

  it("returns false for a non-active member", async () => {
    const {uidA} = newFixture();
    await seedUser(uidA, USER_STATUS.PENDING_DELETION);
    try {
      assert.equal(await isActiveMember(uidA), false);
    } finally {
      await userDocument(uidA).delete();
    }
  });

  it("returns false for a missing user document", async () => {
    const {uidA} = newFixture();
    assert.equal(await isActiveMember(uidA), false);
  });
});

describe("listOwnedDomains", () => {
  it("never includes another uid's domain in the result", async () => {
    const fixture = newFixture();
    const docIdA = `${fixture.uidA}__owned-by-a.com`;
    const docIdB = `${fixture.uidB}__owned-by-b.com`;
    try {
      await seedDomainDoc(docIdA, {uid: fixture.uidA, name: "owned-by-a.com"});
      await seedDomainDoc(docIdB, {uid: fixture.uidB, name: "owned-by-b.com"});

      const resultA = await listOwnedDomains(fixture.uidA);

      assert.equal(resultA.length, 1);
      assert.equal(resultA[0].name, "owned-by-a.com");
    } finally {
      await cleanup(fixture, [docIdA, docIdB]);
    }
  });

  it("returns only the safe 9-field DTO even though the raw doc also " +
    "stores authInfo, registrant, and orderId", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__leaky-test.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "leaky-test.com",
        authInfo: "must-not-leak",
        registrant: "must-not-leak",
        orderId: "must-not-leak",
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      assert.deepEqual(
        Object.keys(item).sort(),
        [
          "autoRenew", "autoRenewCancelableUntil", "exDate", "goneReason",
          "lifecycle", "name", "registry", "restorableUntil", "restoreFeeYen",
          "rgpStatus", "status", "tld",
        ],
      );
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("dates the restore deadline from deletedAt plus the registry's grace " +
    "period", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__deadline.com`;
    const deletedAt = Timestamp.fromDate(new Date("2026-03-01T00:00:00Z"));
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "deadline.com",
        registry: "kitaqnic" as RegistryId,
        status: ["pendingDelete"],
        rgpStatus: ["redemptionPeriod"],
        deletedAt,
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      // Both registries document 45 days (grace-period-days).
      assert.equal(item.restorableUntil, "2026-04-15T00:00:00.000Z");
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("prefers the deadline the registry itself reported", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__reported.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "reported.com",
        status: ["pendingDelete"],
        rgpStatus: ["redemptionPeriod"],
        deletedAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
        // domain:delete's extension.pendingDeleteUntil: the registry's own
        // number beats our deletedAt + 45 arithmetic.
        restorableUntil: "2026-04-20T09:00:00Z",
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      assert.equal(item.restorableUntil, "2026-04-20T09:00:00Z");
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("finds redemptionPeriod in status as well as in rgpStatus", async () => {
    // The registries' prose lists redemptionPeriod among the `status` values
    // while their schema describes RGP statuses as a separate layer; the
    // countdown must not depend on which one is right.
    const fixture = newFixture();
    const docId = `${fixture.uidA}__status-carried.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "status-carried.com",
        registry: "kitaqnic" as RegistryId,
        status: ["pendingDelete", "redemptionPeriod"],
        rgpStatus: [],
        deletedAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      assert.equal(item.restorableUntil, "2026-04-15T00:00:00.000Z");
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("stops offering a deadline once the redemption window has closed",
    async () => {
      // `pendingDelete` alone is the five-day tail: restore answers 2304, so
      // 「あと◯日は戻せます」 would be a promise the registry will not keep.
      const fixture = newFixture();
      const docId = `${fixture.uidA}__tail.com`;
      try {
        await seedDomainDoc(docId, {
          uid: fixture.uidA,
          name: "tail.com",
          status: ["pendingDelete"],
          rgpStatus: [],
          deletedAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
          restorableUntil: "2026-04-15T00:00:00.000Z",
        });

        const [item] = await listOwnedDomains(fixture.uidA);

        assert.equal(item.restorableUntil, null);
      } finally {
        await cleanup(fixture, [docId]);
      }
    });

  it("dates the auto-renew cancel deadline from exDate minus the one-year " +
    "extension plus the grace period", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__renewed.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "renewed.com",
        registry: "kitaqnic" as RegistryId,
        status: ["ok"],
        rgpStatus: ["autoRenewPeriod"],
        // The real registries mirror ISO datetimes (the stub date-only
        // strings; both must derive the same way).
        exDate: "2027-08-27T03:02:41Z",
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      // Renewed at 2026-08-27T03:02:41Z; both registries document 45 days.
      assert.equal(
        item.autoRenewCancelableUntil,
        "2026-10-11T03:02:41.000Z",
      );
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("finds autoRenewPeriod in status as well as in rgpStatus", async () => {
    // Same documents-disagree hedge as the redemptionPeriod test above.
    const fixture = newFixture();
    const docId = `${fixture.uidA}__status-renewed.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "status-renewed.com",
        status: ["ok", "autoRenewPeriod"],
        rgpStatus: [],
        exDate: "2027-08-27T00:00:00Z",
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      assert.equal(
        item.autoRenewCancelableUntil,
        "2026-10-11T00:00:00.000Z",
      );
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("leaves the auto-renew cancel deadline empty outside the window",
    async () => {
      const fixture = newFixture();
      const docId = `${fixture.uidA}__no-window.com`;
      try {
        await seedDomainDoc(docId, {
          uid: fixture.uidA,
          name: "no-window.com",
          status: ["ok"],
          rgpStatus: [],
          exDate: "2027-08-27T00:00:00Z",
        });

        const [item] = await listOwnedDomains(fixture.uidA);

        assert.equal(item.autoRenewCancelableUntil, null,
          "autoRenewPeriod が無いドメインに取り消し期限を出さないこと");
      } finally {
        await cleanup(fixture, [docId]);
      }
    });

  it("leaves the restore deadline empty for a live domain, even if it was " +
    "deleted and restored before", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__revived.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "revived.com",
        status: ["ok"],
        deletedAt: Timestamp.fromDate(new Date("2026-03-01T00:00:00Z")),
      });

      const [item] = await listOwnedDomains(fixture.uidA);

      assert.equal(item.restorableUntil, null,
        "生きているドメインに復旧期限を出さないこと");
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("quotes the restore fee for every domain, so the delete dialog can " +
    "warn before the domain is deleted", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__priced.com`;
    try {
      await seedDomainDoc(docId, {uid: fixture.uidA, name: "priced.com"});

      const [item] = await listOwnedDomains(fixture.uidA);

      // .com restore fee from the 22-TLD table (functions/src/domain/
      // pricing.ts); asserting through priceForRestore would only prove the
      // repository calls it, so the literal is intentional.
      assert.equal(item.restoreFeeYen, 3300);
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("throws instead of returning a document with a malformed deletedAt",
    async () => {
      const fixture = newFixture();
      const docId = `${fixture.uidA}__bad-deleted-at.com`;
      try {
        await seedDomainDoc(docId, {
          uid: fixture.uidA,
          name: "bad-deleted-at.com",
          status: ["pendingDelete"],
          deletedAt: "2026-03-01T00:00:00Z",
        });

        await assert.rejects(() => listOwnedDomains(fixture.uidA));
      } finally {
        await cleanup(fixture, [docId]);
      }
    });

  it("returns an empty list when the member owns no domains", async () => {
    const {uidA} = newFixture();
    assert.deepEqual(await listOwnedDomains(uidA), []);
  });

  it("returns multiple domains sorted by name ascending", async () => {
    const fixture = newFixture();
    const names = ["zulu.com", "alpha.com", "mike.com"];
    const docIds = names.map((name) => `${fixture.uidA}__${name}`);
    try {
      for (const [index, name] of names.entries()) {
        await seedDomainDoc(docIds[index], {uid: fixture.uidA, name});
      }

      const result = await listOwnedDomains(fixture.uidA);

      assert.deepEqual(result.map((item) => item.name), [
        "alpha.com",
        "mike.com",
        "zulu.com",
      ]);
    } finally {
      await cleanup(fixture, docIds);
    }
  });

  it("throws instead of returning a document with a malformed registry",
    async () => {
      const fixture = newFixture();
      const docId = `${fixture.uidA}__malformed.com`;
      try {
        await seedDomainDoc(docId, {
          uid: fixture.uidA,
          name: "malformed.com",
          registry: "not-a-real-registry",
        });

        await assert.rejects(() => listOwnedDomains(fixture.uidA));
      } finally {
        await cleanup(fixture, [docId]);
      }
    });
});

describe("getOwnedDomain", () => {
  it("returns {name, registry} for a domain the caller owns", async () => {
    const fixture = newFixture();
    const docId = `${fixture.uidA}__owned.com`;
    try {
      await seedDomainDoc(docId, {
        uid: fixture.uidA,
        name: "owned.com",
        registry: "kitaqnic" as RegistryId,
      });

      const result = await getOwnedDomain(fixture.uidA, "owned.com");

      assert.deepEqual(result, {name: "owned.com", registry: "kitaqnic"});
    } finally {
      await cleanup(fixture, [docId]);
    }
  });

  it("returns null for a domain that does not exist", async () => {
    const {uidA} = newFixture();
    assert.equal(await getOwnedDomain(uidA, "does-not-exist.com"), null);
  });

  it("returns null for a document whose stored uid/name do not match the " +
    "requested key (corrupted or mismatched mirror data)", async () => {
    const fixture = newFixture();
    // The document id embeds uidA, but the stored uid field is uidB's — a
    // corrupted-data scenario that must never resolve to ownership.
    const mismatchedUidDocId = `${fixture.uidA}__mismatched-uid.com`;
    const mismatchedNameDocId = `${fixture.uidA}__mismatched-name.com`;
    try {
      await seedDomainDoc(mismatchedUidDocId, {
        uid: fixture.uidB,
        name: "mismatched-uid.com",
      });
      await seedDomainDoc(mismatchedNameDocId, {
        uid: fixture.uidA,
        name: "a-different-name.com",
      });

      assert.equal(
        await getOwnedDomain(fixture.uidA, "mismatched-uid.com"),
        null,
      );
      assert.equal(
        await getOwnedDomain(fixture.uidA, "mismatched-name.com"),
        null,
      );
    } finally {
      await cleanup(fixture, [mismatchedUidDocId, mismatchedNameDocId]);
    }
  });

  it("throws instead of returning a document with a malformed registry",
    async () => {
      const fixture = newFixture();
      const docId = `${fixture.uidA}__malformed-detail.com`;
      try {
        await seedDomainDoc(docId, {
          uid: fixture.uidA,
          name: "malformed-detail.com",
          registry: 12345,
        });

        await assert.rejects(
          () => getOwnedDomain(fixture.uidA, "malformed-detail.com"),
        );
      } finally {
        await cleanup(fixture, [docId]);
      }
    });
});
