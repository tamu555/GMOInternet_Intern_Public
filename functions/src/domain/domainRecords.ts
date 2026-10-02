/**
 * The `domains` collection: ownership and registry-state synchronisation.
 *
 * Every operation on a domain has to prove the caller owns it before it
 * reaches the registry (spec 7.3). `firestore.rules` denies all client access,
 * so this module is the only place that check can live.
 *
 * The registry is the source of truth for status. Nothing here guesses what a
 * command did to a domain — it writes back what `domain:info` reports.
 */
import {FieldValue} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {tldOf} from "../bridge/registryRouter";
import type {DomainInfo} from "../bridge/types";

/**
 * Where a domain sits in its life cycle, collapsed to what the list screen
 * needs (spec 6.5: two sections, not three).
 */
export type DomainLifecycle =
  /** Registered and ours. */
  | "active"
  /** Deleted, inside the RGP redemption window, still restorable. */
  | "pendingDelete"
  /**
   * Past the point of no return: either the registry no longer has the name,
   * or the redemption window closed and only the short, non-restorable
   * `pendingDelete` tail is left before the name is purged (see
   * {@link lifecycleFromStatus}).
   */
  | "gone";

/**
 * The RGP status that makes a deleted domain restorable (RFC 3915).
 *
 * Both registries document the same state machine: `domain:delete` puts the
 * domain into `redemptionPeriod` *and* `pendingDelete`; `domain:restore` works
 * only while `redemptionPeriod` is there. After `grace-period-days` (45) a
 * per-minute batch drops `redemptionPeriod`, leaving `pendingDelete` alone —
 * restore then answers 2304 — and `pending-delete-days` (5) later the name is
 * purged.
 */
export const REDEMPTION_PERIOD = "redemptionPeriod";

/**
 * Whether the registry's own view says the domain can still be restored.
 *
 * Both arrays are searched because the documents disagree with themselves
 * about where `redemptionPeriod` surfaces: the status table in
 * `info.description` lists it among `domain:info`'s `status` values, while
 * `DomainResponse.rgpStatus` describes RGP statuses as a separate layer (and
 * the local stub puts it there). Looking in one place only would make the
 * restore button depend on which document happens to be right.
 *
 * @param {string[] | undefined} status `domain:info` status array.
 * @param {string[] | undefined} rgpStatus `domain:info` RGP status array.
 * @return {boolean} True while the restore window is open.
 */
export function isRestorable(
  status: string[] | undefined,
  rgpStatus: string[] | undefined,
): boolean {
  return (status ?? []).includes(REDEMPTION_PERIOD) ||
    (rgpStatus ?? []).includes(REDEMPTION_PERIOD);
}

/**
 * The RGP status carried for 45 days after a registry-side auto-renew
 * (§3.6 of both Swaggers: 「自動更新の直後から 45 日間」).
 */
export const AUTO_RENEW_PERIOD = "autoRenewPeriod";

/**
 * Whether the domain is inside its auto-renew grace window.
 *
 * Both arrays are searched for the same reason as {@link isRestorable}: the
 * registry documents disagree about whether RGP statuses surface in `status`
 * or in `rgpStatus`, and the countdown must not depend on which one is right.
 *
 * @param {string[] | undefined} status `domain:info` status array.
 * @param {string[] | undefined} rgpStatus `domain:info` RGP status array.
 * @return {boolean} True while the auto-renew can still be cancelled.
 */
export function isInAutoRenewGrace(
  status: string[] | undefined,
  rgpStatus: string[] | undefined,
): boolean {
  return (status ?? []).includes(AUTO_RENEW_PERIOD) ||
    (rgpStatus ?? []).includes(AUTO_RENEW_PERIOD);
}

/** Stored shape of a domain we registered. */
export interface DomainRecord {
  uid: string;
  name: string;
  tld: string;
  registry: RegistryId;
  lifecycle: DomainLifecycle;
  status: string[];
  rgpStatus: string[];
  nameservers: string[];
  registrant?: string | null;
  authInfo?: string | null;
  crDate?: string | null;
  exDate?: string | null;
  autoRenew?: boolean;
  /**
   * `autoRenew` as it was just before the delete that created the current
   * `pendingDelete` state, so a restore can put it back (spec 6.4/6.5): the
   * delete itself always forces `autoRenew` to false, which would otherwise
   * make the app-side batch re-delete the domain at `exDate`.
   *
   * Absent on a live domain, and on a domain deleted before this field
   * existed — see `restoreOwnedDomain` for what a restore does then.
   */
  autoRenewBeforeDelete?: boolean;
  /**
   * The registry's own restore deadline, taken from `domain:delete`'s
   * `extension.pendingDeleteUntil` (both documents: 「redemptionPeriod 期限の
   * 目安は extension.pendingDeleteUntil」). ISO 8601.
   *
   * Absent when the registry did not send one, and on a domain deleted before
   * this field existed; `gracePeriod.ts` then derives the deadline from
   * `deletedAt` instead.
   */
  restorableUntil?: string | null;
  orderId?: string | null;
}

/** Raised when the caller does not own the domain, or it does not exist. */
export class DomainNotOwnedError extends Error {
  readonly domainName: string;

  /**
   * @param {string} domainName Domain the caller asked for.
   */
  constructor(domainName: string) {
    super(`domain not owned by caller: ${domainName}`);
    this.name = "DomainNotOwnedError";
    this.domainName = domainName;
  }
}

/**
 * Document id for a member's domain.
 *
 * Scoping the id by uid means an ownership check is a point read rather than
 * a query, so there is no window where a stale index could hand one member
 * another member's domain.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Domain name.
 * @return {string} Firestore document id.
 */
export function domainDocId(uid: string, name: string): string {
  return `${uid}__${name}`;
}

/**
 * Loads a domain, insisting that it belongs to the caller.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Domain name.
 * @return {Promise<DomainRecord>} The caller's domain.
 */
export async function loadOwnedDomain(
  uid: string,
  name: string,
): Promise<DomainRecord> {
  const snapshot = await db()
    .collection(COLLECTIONS.domains)
    .doc(domainDocId(uid, name))
    .get();

  const data = snapshot.data() as DomainRecord | undefined;
  if (!snapshot.exists || !data || data.uid !== uid) {
    throw new DomainNotOwnedError(name);
  }
  return data;
}

/**
 * Derives the life-cycle bucket from the registry's own status lists.
 *
 * `pendingDelete` on its own is *not* the restorable state: it stays on the
 * domain for the five non-restorable days after `redemptionPeriod` expires,
 * during which `domain:restore` answers 2304. Only `redemptionPeriod` means
 * "still restorable", so the tail is bucketed with `gone` rather than
 * promising a restore that cannot happen.
 *
 * @param {string[] | undefined} status `domain:info` status array.
 * @param {string[] | undefined} rgpStatus `domain:info` RGP status array.
 * @return {DomainLifecycle} Bucket for the list screen.
 */
export function lifecycleFromStatus(
  status: string[] | undefined,
  rgpStatus: string[] | undefined,
): DomainLifecycle {
  if (isRestorable(status, rgpStatus)) return "pendingDelete";
  return (status ?? []).includes("pendingDelete") ? "gone" : "active";
}

/** Fields a caller may set alongside the registry state. */
export interface DomainRecordPatch {
  /**
   * Only for callers that have no fresh `domain:info` but do know the bucket
   * — a successful `domain:create` is certainly `active`.
   */
  lifecycle?: DomainLifecycle;
  status?: string[];
  rgpStatus?: string[];
  registry?: RegistryId;
  registrant?: string | null;
  authInfo?: string | null;
  orderId?: string | null;
  autoRenew?: boolean;
  /** Mirror of `autoRenew` taken before a delete; `FieldValue.delete()`
   * removes it once a restore has put the flag back. */
  autoRenewBeforeDelete?: boolean | FieldValue;
  nameservers?: string[];
  crDate?: string | null;
  exDate?: string | null;
  /** Set by delete; `FieldValue.delete()` clears it on a successful restore. */
  deletedAt?: FieldValue;
  /** Registry-reported restore deadline; cleared the same way. */
  restorableUntil?: string | null | FieldValue;
  restoredAt?: FieldValue;
  /** Set when an approved outbound transfer took the domain away (6.6). */
  transferredAt?: FieldValue;
  /**
   * When the AuthCode was last re-minted (spec 3.9). Only the moment is
   * recorded: `rotateAuthInfo.ts` deliberately keeps no copy of the value
   * itself, and clears `authInfo` in the same write because whatever was
   * stored there stopped working the instant the registry answered.
   */
  authInfoRotatedAt?: FieldValue;
}

/**
 * Writes the registry's view of a domain back to Firestore.
 *
 * `info` has three meanings:
 *   a DomainInfo — the registry's current view, written verbatim
 *   null         — `domain:info` says it is no longer there, so `gone`
 *   undefined    — no fresh read; keep the stored registry fields and let
 *                  `patch` supply what the caller does know
 *
 * A record marked `gone` is kept rather than deleted, so the member can still
 * see what became of the domain.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} name Domain name.
 * @param {DomainInfo | null | undefined} info Registry state, if it was read.
 * @param {DomainRecordPatch} patch Extra fields to store.
 * @return {Promise<DomainLifecycle | undefined>} Life cycle written, if any.
 */
export async function syncDomainRecord(
  uid: string,
  name: string,
  info: DomainInfo | null | undefined,
  patch: DomainRecordPatch = {},
): Promise<DomainLifecycle | undefined> {
  let lifecycle: DomainLifecycle | undefined = patch.lifecycle;
  let fromRegistry: Record<string, unknown> = {};

  if (info === null) {
    lifecycle = "gone";
    fromRegistry = {status: ["gone"], rgpStatus: []};
  } else if (info !== undefined) {
    lifecycle = lifecycleFromStatus(info.status, info.rgpStatus);
    fromRegistry = {
      registry: info.registry,
      status: info.status,
      rgpStatus: info.rgpStatus,
      nameservers: info.nameservers,
      registrant: info.registrant,
      crDate: info.crDate,
      exDate: info.exDate ?? null,
    };
  }

  await db()
    .collection(COLLECTIONS.domains)
    .doc(domainDocId(uid, name))
    .set(
      {
        uid,
        name,
        tld: tldOf(name),
        ...(lifecycle ? {lifecycle} : {}),
        ...fromRegistry,
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );

  return lifecycle;
}
