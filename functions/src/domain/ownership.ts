/**
 * Per-resource ownership checks for domain/contact/host mutations.
 *
 * This is the first per-resource authorization boundary in the codebase
 * (spec 7.3). Every mutating command (`domain:update`, `contact:update`,
 * `host:update`, `host:create`) must pass through one of these helpers before
 * a Firestore operation is reserved or a registry call is made.
 *
 * The overriding security rule: "the document does not exist" and "the
 * document exists but belongs to a different uid" are indistinguishable to
 * the caller. Both collapse into the exact same `OwnershipError` (same
 * message, same `reason`), so a caller cannot use this feature to enumerate
 * which domain/contact/host names exist for other members (IDOR-adjacent
 * information leak). A malformed document (e.g. a corrupt `registry` value)
 * is treated the same way, on the theory that a document we cannot trust is
 * a document we must not reveal.
 *
 * A resource that is genuinely owned by the caller but not `ready` (a
 * mutation is already in flight, or the object never finished being
 * created) is a *different* failure: it does not leak anything about other
 * members, so it is reported distinctly (`reason: "not_ready"`) and mapped
 * by the API layer to `failed-precondition`/`aborted` rather than
 * `permission-denied`.
 */
import type {DocumentReference, Firestore} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase.js";
import type {RegistryId} from "../config/options.js";

/** The three EPP object kinds this feature can mutate. */
export type ResourceKind = "domain" | "contact" | "host";

/** Why an ownership check failed. */
export type OwnershipFailureReason = "not_owned" | "not_ready";

/** Caller-owned domain, resolved and validated against Firestore. */
export interface OwnedDomain {
  kind: "domain";
  ref: DocumentReference;
  uid: string;
  name: string;
  registry: RegistryId;
}

/** Caller-owned contact, resolved and validated against Firestore. */
export interface OwnedContact {
  kind: "contact";
  ref: DocumentReference;
  uid: string;
  contactId: string;
  registry: RegistryId;
}

/** Caller-owned host, resolved and validated against Firestore. */
export interface OwnedHost {
  kind: "host";
  ref: DocumentReference;
  uid: string;
  name: string;
  parentDomain: string;
  registry: RegistryId;
}

/** Any one of the three ownership results, for kind-generic callers. */
export type OwnedResource = OwnedDomain | OwnedContact | OwnedHost;

/**
 * Raised by every `assertOwns*` helper. `reason` is intentionally coarse
 * (see module doc): it is safe to log and safe to map to an HttpsError code,
 * but never safe to reveal the underlying cause (missing vs. foreign vs.
 * malformed) to the caller.
 */
export class OwnershipError extends Error {
  readonly resourceKind: ResourceKind;
  readonly reason: OwnershipFailureReason;

  /**
   * @param {ResourceKind} resourceKind Kind of resource being checked.
   * @param {OwnershipFailureReason} reason Coarse failure category.
   * @param {string} message Human-readable, client-safe reason.
   */
  constructor(
    resourceKind: ResourceKind,
    reason: OwnershipFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "OwnershipError";
    this.resourceKind = resourceKind;
    this.reason = reason;
  }
}

const NOT_OWNED_MESSAGE: Record<ResourceKind, string> = {
  domain: "対象のドメインが見つからないか、このアカウントの所有物ではありません。",
  contact: "対象の連絡先が見つからないか、このアカウントの所有物ではありません。",
  host: "対象のホストが見つからないか、このアカウントの所有物ではありません。",
};

const NOT_READY_MESSAGE: Record<ResourceKind, string> = {
  domain: "対象のドメインは現在更新できない状態です。",
  contact: "対象の連絡先は現在更新できない状態です。",
  host: "対象のホストは現在更新できない状態です。",
};

/**
 * @param {ResourceKind} kind Resource kind that failed the check.
 * @return {OwnershipError} Error for "missing / foreign / malformed".
 */
function notOwned(kind: ResourceKind): OwnershipError {
  return new OwnershipError(kind, "not_owned", NOT_OWNED_MESSAGE[kind]);
}

/**
 * @param {ResourceKind} kind Resource kind that failed the check.
 * @return {OwnershipError} Error for "owned, but not ready for mutation".
 */
function notReady(kind: ResourceKind): OwnershipError {
  return new OwnershipError(kind, "not_ready", NOT_READY_MESSAGE[kind]);
}

/**
 * @param {unknown} value Candidate registry value from Firestore.
 * @return {boolean} Whether the value is a recognised registry id.
 */
function isRegistryId(value: unknown): value is RegistryId {
  return value === "kitaqsign" || value === "kitaqnic";
}

/**
 * Documents written before this feature existed carry no `syncState` field
 * at all. Absence is accepted as an implicit `ready`, purely for backward
 * compatibility with domains created by `provisionDomain.ts` before update
 * support landed; any explicit value other than `"ready"` is not.
 *
 * @param {unknown} syncState Raw `syncState` field from the domain document.
 * @return {boolean} Whether the domain is safe to mutate.
 */
function isDomainSyncReady(syncState: unknown): boolean {
  return syncState === undefined || syncState === "ready";
}

/**
 * Verifies the caller owns `name` and that the domain is in a mutable state.
 *
 * @param {string} uid Firebase Authentication uid of the caller.
 * @param {string} name Canonical (already-normalised) domain name.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<OwnedDomain>} The owned, ready-to-mutate domain.
 */
export async function assertOwnsDomain(
  uid: string,
  name: string,
  firestore: Firestore = db(),
): Promise<OwnedDomain> {
  const ref = firestore.collection(COLLECTIONS.domains).doc(`${uid}__${name}`);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data) throw notOwned("domain");
  if (data.uid !== uid || data.name !== name) throw notOwned("domain");
  // A gone mirror (transferred away, or purged after the grace period) is
  // no longer the member's to mutate: the registry-side name may already
  // belong to somebody else, and our registrar credentials would let a
  // stale mirror reach it. Coarse not-owned on purpose (module doc).
  if (data.lifecycle === "gone") throw notOwned("domain");
  if (!isRegistryId(data.registry)) throw notOwned("domain");
  if (!isDomainSyncReady(data.syncState)) throw notReady("domain");
  return {kind: "domain", ref, uid, name, registry: data.registry};
}

/**
 * Verifies the caller owns `contactId` on `requiredRegistry` and that the
 * contact finished being created.
 *
 * `requiredRegistry` must be resolved server-side (e.g. from the stored
 * registry of a caller-owned domain) — never accepted as a raw client input
 * for this check, otherwise a caller could probe another registry's contact
 * space for a contact id that happens to collide.
 *
 * @param {string} uid Firebase Authentication uid of the caller.
 * @param {string} contactId Contact id the caller claims to own.
 * @param {RegistryId} requiredRegistry Registry resolved server-side.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<OwnedContact>} The owned, ready-to-mutate contact.
 */
export async function assertOwnsContact(
  uid: string,
  contactId: string,
  requiredRegistry: RegistryId,
  firestore: Firestore = db(),
): Promise<OwnedContact> {
  const ref = firestore
    .collection(COLLECTIONS.registryContacts)
    .doc(`${uid}__${requiredRegistry}`);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data) throw notOwned("contact");
  if (data.uid !== uid) throw notOwned("contact");
  if (data.contactId !== contactId) throw notOwned("contact");
  if (data.registry !== requiredRegistry) throw notOwned("contact");
  if (data.state !== "ready") throw notReady("contact");
  return {kind: "contact", ref, uid, contactId, registry: requiredRegistry};
}

/**
 * Verifies the caller owns host `name` and that it finished being created.
 *
 * Depends on `COLLECTIONS.registryHosts`, added to
 * `functions/src/config/firebase.ts` alongside this feature's other
 * Firestore-schema work.
 *
 * @param {string} uid Firebase Authentication uid of the caller.
 * @param {string} name Canonical (already-normalised) host name.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<OwnedHost>} The owned, ready-to-mutate host.
 */
export async function assertOwnsHost(
  uid: string,
  name: string,
  firestore: Firestore = db(),
): Promise<OwnedHost> {
  const ref = firestore
    .collection(COLLECTIONS.registryHosts)
    .doc(`${uid}__${name}`);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data) throw notOwned("host");
  if (data.uid !== uid || data.name !== name) throw notOwned("host");
  if (!isRegistryId(data.registry)) throw notOwned("host");
  if (typeof data.parentDomain !== "string" || !data.parentDomain) {
    throw notOwned("host");
  }
  if (data.lifecycleState !== "ready") throw notReady("host");
  return {
    kind: "host",
    ref,
    uid,
    name,
    parentDomain: data.parentDomain,
    registry: data.registry,
  };
}
