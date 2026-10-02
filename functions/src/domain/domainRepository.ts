/**
 * The sole tenant-boundary enforcement point for the EPP Info feature.
 *
 * The Admin SDK bypasses Firestore Security Rules, so the checks in this file
 * are the only thing standing between one member and another member's domain
 * data. Every read here is either scoped to the caller's own `uid` (the list
 * query) or keyed by a document id that already embeds the caller's `uid`
 * (the single-domain lookup) — no query in this file can ever match a
 * document that belongs to someone else.
 *
 * The `domains` mirror also stores `authInfo`, `registrant` and `orderId`
 * (spec: `provisionDomain.ts`'s `saveDomain()`). Nothing in this file ever
 * returns the raw document: every response is hand-built from an explicit,
 * runtime-validated field list.
 */
import {Timestamp, type DocumentData, type Query} from
  "firebase-admin/firestore";
import {USER_STATUS} from "../auth/constants";
import {userDocument} from "../auth/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {isInAutoRenewGrace, isRestorable} from "./domainRecords";
import {autoRenewCancelableUntilOf, restorableUntilOf} from "./gracePeriod";
import {priceForRestore} from "./pricing";

/** Safe projection of one domain, as returned by the list Callable. */
export interface DomainListItem {
  name: string;
  tld: string;
  registry: RegistryId;
  status: string[];
  rgpStatus: string[];
  exDate: string | null;
  autoRenew: boolean;
  /**
   * ISO 8601 moment after which restore stops working, for a domain that is
   * still in `redemptionPeriod`. The registry's own
   * `extension.pendingDeleteUntil` when the delete reported one, otherwise
   * `deletedAt` + the registry's grace period (see `gracePeriod.ts`).
   *
   * Null for a live domain, for one whose redemption window has already
   * closed — the screens use that to stop offering a restore — and for a
   * mirror written before `deletedAt` was recorded.
   */
  restorableUntil: string | null;
  /**
   * ISO 8601 moment after which a registry-side auto-renew can no longer be
   * cancelled, for a domain currently carrying `autoRenewPeriod` (§3.6).
   * Neither registry reports the deadline itself, so it is derived here from
   * `exDate` (see `gracePeriod.ts`) — the same server-side single-source rule
   * as `restorableUntil`. Null while the window is not open, and for a mirror
   * without a parseable `exDate`.
   */
  autoRenewCancelableUntil: string | null;
  /**
   * Which section of the list the domain belongs to. `gone` covers both a
   * completed outbound transfer and a deletion whose redemption window
   * closed: either way the member no longer holds the name, so it must not
   * appear under アクティブ, must not link to the detail screen, and no
   * operation may be issued against it — the same name may already belong
   * to someone else (spec 7.3).
   */
  lifecycle: "active" | "pendingDelete" | "gone";
  /** Why a `gone` domain left, for the row's label. Null otherwise. */
  goneReason: "transferred" | "unrecoverable" | null;
  /**
   * What an RGP restore of this domain would cost (spec 6.5: restore is not
   * free, and the screen has to say so *before* the delete). A price-table
   * lookup, not stored state, so it is answered for every domain — the delete
   * dialog needs it while the domain is still live.
   */
  restoreFeeYen: number;
}

/** Ownership-check result: only what the live-info orchestration needs. */
export interface OwnedDomain {
  name: string;
  registry: RegistryId;
}

/** Firestore fields read for the list projection (spec: field projection). */
const LIST_FIELDS = [
  "name",
  "tld",
  "registry",
  "status",
  "rgpStatus",
  "exDate",
  "autoRenew",
  // Not shown as-is: the deadline derived from it is (spec 3.5's
  // 「解約手続き中（あと◯日は戻せます）」).
  "deletedAt",
  // The registry's own deadline, when the delete reported one.
  "restorableUntil",
  // Which bucket the list screen shows the domain in; "gone" rows are the
  // 使用不可 section and are not clickable.
  "lifecycle",
  // Present on a mirror that left via a completed outbound transfer —
  // that is what tells 「移管済み」 apart from 「復旧不可」.
  "transferredAt",
] as const;

/**
 * Narrows an unknown value to a known registry id.
 *
 * @param {unknown} value Raw Firestore field value.
 * @return {boolean} Whether the value is a valid RegistryId.
 */
function isRegistryId(value: unknown): value is RegistryId {
  return value === "kitaqsign" || value === "kitaqnic";
}

/**
 * Narrows an unknown value to an array of strings.
 *
 * @param {unknown} value Raw Firestore field value.
 * @return {boolean} Whether the value is a string array.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

/**
 * Narrows an unknown value to a `deletedAt` the projection can use: the field
 * is absent on every domain that was never deleted.
 *
 * @param {unknown} value Raw Firestore field value.
 * @return {boolean} Whether the value is a Timestamp or simply missing.
 */
function isOptionalTimestamp(
  value: unknown,
): value is Timestamp | undefined | null {
  return value === undefined || value === null || value instanceof Timestamp;
}

/**
 * Derives the restore deadline shown next to a deleted domain.
 *
 * Only a domain the registry currently reports as being in
 * `redemptionPeriod` gets one, and that is the whole point: `pendingDelete`
 * survives the redemption window by five non-restorable days, so keying the
 * countdown on it would print 「あと◯日は戻せます」 next to a domain that can
 * no longer be brought back. A `deletedAt` left behind by an earlier life
 * cycle would likewise put a countdown on a live domain.
 *
 * The registry's own `pendingDeleteUntil` wins when the delete reported one;
 * `deletedAt` + the per-registry grace period is the fallback for domains
 * deleted before it was stored, or by a registry that sent none.
 *
 * @param {string[]} status Registry status list from the mirror.
 * @param {string[]} rgpStatus Registry RGP status list from the mirror.
 * @param {RegistryId} registry Registry holding the domain.
 * @param {Timestamp | undefined | null} deletedAt When delete was issued.
 * @param {string | undefined | null} reported Deadline the registry sent.
 * @return {string | null} ISO 8601 deadline, or null when there is none.
 */
function restorableUntilFromMirror(
  status: string[],
  rgpStatus: string[],
  registry: RegistryId,
  deletedAt: Timestamp | undefined | null,
  reported: string | undefined | null,
): string | null {
  if (!isRestorable(status, rgpStatus)) return null;
  if (reported) return reported;
  if (deletedAt === undefined || deletedAt === null) return null;
  return restorableUntilOf(registry, deletedAt.toDate());
}

/**
 * Derives the cancel deadline shown on the 「自動で1年延びました」 badge.
 *
 * Only a domain the registry currently reports inside `autoRenewPeriod` gets
 * one — once the registry drops the status (45 days after the renewal) the
 * hint disappears with it, so a stale countdown can never outlive the window
 * it describes. The deadline itself is `exDate` minus the one-year extension
 * plus the grace period (`gracePeriod.ts`), because neither registry reports
 * an explicit end moment.
 *
 * @param {string[]} status Registry status list from the mirror.
 * @param {string[]} rgpStatus Registry RGP status list from the mirror.
 * @param {RegistryId} registry Registry holding the domain.
 * @param {string | null} exDate Current (already-extended) expiry.
 * @return {string | null} ISO 8601 deadline, or null when there is none.
 */
function autoRenewCancelableUntilFromMirror(
  status: string[],
  rgpStatus: string[],
  registry: RegistryId,
  exDate: string | null,
): string | null {
  if (!isInAutoRenewGrace(status, rgpStatus)) return null;
  if (exDate === null) return null;
  const parsed = new Date(exDate);
  // A mirror whose exDate does not parse (real registries answer ISO
  // datetimes, the stub date-only strings — both parse; anything else is
  // corrupt) just loses the hint, never the whole list.
  if (Number.isNaN(parsed.getTime())) return null;
  return autoRenewCancelableUntilOf(registry, parsed);
}

/**
 * Derives which lifecycle bucket a `domains` mirror document belongs to.
 *
 * A mirror written before the `lifecycle` field existed (or one whose write
 * otherwise raced ahead of it) falls back to the registry `status` array,
 * the same fallback `domainRecords.ts`'s `lifecycleFromStatus` uses when it
 * derives a bucket from a *live* registry read - this function and that one
 * are deliberately not merged (one reads a stored Firestore projection, the
 * other a fresh registry response), but they agree on what `"gone"` and
 * `"pendingDelete"` mean.
 *
 * Shared by `toDomainListItem` (the list Callable, via `listOwnedDomains`)
 * and the account-deletion domain-ownership guard
 * (`auth/account-lifecycle.ts`'s `countOwnedDomainsInTransaction`), so both
 * agree on which mirrors are `"gone"` - a completed outbound transfer, or a
 * deletion whose redemption window already closed - even though only the
 * deletion guard excludes `"gone"` mirrors from what it counts as "owned".
 *
 * @param {unknown} storedLifecycle Raw `lifecycle` field from the mirror.
 * @param {string[]} status Raw `status` array from the mirror.
 * @return {"active" | "pendingDelete" | "gone"} The bucket this mirror
 *   belongs to.
 */
export function deriveDomainLifecycle(
  storedLifecycle: unknown,
  status: string[],
): DomainListItem["lifecycle"] {
  if (storedLifecycle === "gone" || status.includes("gone")) return "gone";
  if (storedLifecycle === "pendingDelete" || status.includes("pendingDelete")) {
    return "pendingDelete";
  }
  return "active";
}

/**
 * Builds a `DomainListItem` from one mirror document, validating every field
 * at runtime rather than trusting the stored shape.
 *
 * A malformed field never becomes part of the response: it fails the whole
 * call instead, since a best-effort guess about a corrupted registry mirror
 * is worse than an error page.
 *
 * Two fields are derived rather than stored: `restorableUntil` (from
 * `deletedAt` plus the registry's grace period) and `restoreFeeYen` (a price
 * lookup). Deriving them here keeps both rules on the server, where the
 * screens cannot drift from them.
 *
 * @param {string} docId Mirror document id, for the error message only.
 * @param {DocumentData} data Projected document fields.
 * @return {DomainListItem} Safe, explicit DTO.
 */
function toDomainListItem(
  docId: string,
  data: DocumentData,
): DomainListItem {
  const name = data.name;
  const tld = data.tld;
  const registry = data.registry;
  const status = data.status ?? [];
  const rgpStatus = data.rgpStatus ?? [];
  const exDate = data.exDate ?? null;
  const autoRenew = data.autoRenew;
  const deletedAt = data.deletedAt;
  const reportedRestorableUntil = data.restorableUntil ?? null;

  if (
    typeof name !== "string" ||
    typeof tld !== "string" ||
    !isRegistryId(registry) ||
    !isStringArray(status) ||
    !isStringArray(rgpStatus) ||
    (exDate !== null && typeof exDate !== "string") ||
    typeof autoRenew !== "boolean" ||
    !isOptionalTimestamp(deletedAt) ||
    (reportedRestorableUntil !== null &&
      typeof reportedRestorableUntil !== "string")
  ) {
    throw new Error(`domains/${docId} has a malformed mirror document`);
  }

  const lifecycle = deriveDomainLifecycle(data.lifecycle, status);
  const goneReason: DomainListItem["goneReason"] =
    lifecycle !== "gone" ?
      null :
      data.transferredAt ? "transferred" : "unrecoverable";

  return {
    name,
    tld,
    registry,
    status,
    rgpStatus,
    exDate,
    autoRenew,
    lifecycle,
    goneReason,
    restorableUntil: restorableUntilFromMirror(
      status,
      rgpStatus,
      registry,
      deletedAt,
      reportedRestorableUntil,
    ),
    autoRenewCancelableUntil: autoRenewCancelableUntilFromMirror(
      status,
      rgpStatus,
      registry,
      exDate,
    ),
    restoreFeeYen: priceForRestore(name),
  };
}

/**
 * Checks whether `users/{uid}` exists and is in the `active` state.
 *
 * Firestore operational failures (network, permission, etc.) are not
 * swallowed here: they propagate so the caller can map them to `internal`.
 *
 * @param {string} uid Firebase Authentication user id.
 * @return {Promise<boolean>} False for a missing or non-active user doc.
 */
export async function isActiveMember(uid: string): Promise<boolean> {
  const snapshot = await userDocument(uid).get();
  if (!snapshot.exists) return false;
  return snapshot.data()?.status === USER_STATUS.ACTIVE;
}

/**
 * Builds the tenant-scoped `domains` query for one member.
 *
 * The single definition of "which Firestore documents belong to this uid" -
 * reused by `listOwnedDomains` (the list Callable) and, as the base query it
 * further narrows with `deriveDomainLifecycle`, by the account-deletion
 * domain-ownership guard (`auth/account-lifecycle.ts`'s
 * `countOwnedDomainsInTransaction`), so the two can never drift into
 * disagreeing about which Firestore documents are this member's.
 *
 * Deliberately unfiltered by `lifecycle` at this layer: every document this
 * query can return - including a `pendingDelete` mirror mid-redemption and a
 * `gone` mirror left behind by a completed transfer or an already-closed
 * redemption window - still carries this member's `uid`, and `listOwnedDomains`
 * shows all of them (a `gone` row is still the member's own record of what
 * happened to a name they used to hold). The deletion guard is the one
 * caller that narrows further, since a `gone` mirror must not keep blocking
 * deletion forever.
 *
 * @param {string} uid Firebase Authentication user id.
 * @return {Query<DocumentData>} Tenant-scoped domains query.
 */
export function ownedDomainsQuery(uid: string): Query<DocumentData> {
  return db().collection(COLLECTIONS.domains).where("uid", "==", uid);
}

/**
 * Lists the domains owned by one member, safe-projected for the client.
 *
 * The `uid == uid` filter is the tenant boundary for the list flow: no other
 * member's document can ever be included in the result. The Firestore-level
 * field projection (`select`) is a second, independent guard against
 * `authInfo` leaking even if this function is later changed carelessly.
 *
 * @param {string} uid Firebase Authentication user id.
 * @return {Promise<DomainListItem[]>} Owned domains, sorted by name.
 */
export async function listOwnedDomains(
  uid: string,
): Promise<DomainListItem[]> {
  const snapshot = await ownedDomainsQuery(uid)
    .select(...LIST_FIELDS)
    .get();

  const items = snapshot.docs.map((doc) =>
    toDomainListItem(doc.id, doc.data()),
  );
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Verifies ownership of one domain and returns just enough to run a live
 * `domain:info` lookup.
 *
 * Reads only `${uid}__${normalizedName}` — never a query that could match a
 * differently-keyed document belonging to another member. A missing
 * document, and a document whose stored `uid`/`name` do not match the
 * requested key, are both denial: they return `null` through the identical
 * path, so a caller cannot distinguish "does not exist" from "owned by
 * someone else" (uniform not-found, spec Open Decision e).
 *
 * @param {string} uid Firebase Authentication user id.
 * @param {string} normalizedName Domain name, already normalised.
 * @return {Promise<OwnedDomain | null>} Ownership result.
 */
export async function getOwnedDomain(
  uid: string,
  normalizedName: string,
): Promise<OwnedDomain | null> {
  const docId = `${uid}__${normalizedName}`;
  const snapshot = await db().collection(COLLECTIONS.domains).doc(docId).get();
  if (!snapshot.exists) return null;

  const data = snapshot.data();
  if (!data || data.uid !== uid || data.name !== normalizedName) {
    return null;
  }

  // A gone mirror is a domain the member no longer holds — transferred
  // away, or purged after the grace period. The same name may already be
  // someone else's, and a live `domain:info` here would show *their* data
  // under this member's detail screen. Identical to not-found on purpose.
  if (data.lifecycle === "gone") return null;

  const registry = data.registry;
  if (!isRegistryId(registry)) {
    throw new Error(`domains/${docId} has a malformed mirror document`);
  }

  return {name: data.name, registry};
}
