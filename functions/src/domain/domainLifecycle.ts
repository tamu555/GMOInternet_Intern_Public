/**
 * Delete and restore — the two halves of FIG.4.
 *
 *   ok ──delete──▶ redemptionPeriod ──restore──▶ ok
 *                  (+ pendingDelete)
 *                        │
 *                        └─(45 days)─▶ pendingDelete alone ─(5 days)─▶ purged
 *
 * Both registries document that RGP state machine identically (RFC 3915): the
 * delete puts the domain in `redemptionPeriod` *and* `pendingDelete`, a
 * per-minute batch drops `redemptionPeriod` after `grace-period-days` (45),
 * and only the un-restorable `pendingDelete` tail is left until the name is
 * purged `pending-delete-days` (5) later. Restore outside `redemptionPeriod`
 * answers 2304, which is why "still deleteable/restorable" is decided on
 * `redemptionPeriod` and never on `pendingDelete` alone (spec 6.5).
 *
 * The registry still owns the status: neither command guesses what it did,
 * both ask `domain:info` afterwards and write back what it says.
 *
 * Deleting is destructive and restoring costs money, so both start by proving
 * the caller owns the domain (spec 7.3).
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {isRegistryError} from "../bridge/errors";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryClient} from "../bridge/registryClient";
import type {DomainDeleteOutcome, DomainInfo} from "../bridge/types";
import {REGISTRY_IDS, type RegistryId} from "../config/options";
import {domainClTrid} from "./clTrid";
import {
  isRestorable,
  lifecycleFromStatus,
  loadOwnedDomain,
  syncDomainRecord,
  type DomainLifecycle,
  type DomainRecord,
} from "./domainRecords";
import {retargetOpenOrders} from "./orders";
import {priceForRestore} from "./pricing";

/** Why a life-cycle command cannot proceed. */
export type DomainLifecycleErrorReason =
  /** The name is no longer at any registry we talk to. */
  | "gone"
  /** The domain is not in the state the command needs. */
  | "notPendingDelete"
  /** Another registrar sponsors it. */
  | "notSponsored"
  /**
   * The domain turned out to live at the *other* registry: the mirror has
   * just been healed, and the same command will work on the next attempt.
   * Retryable — see `confirmGoneAcrossRegistries`.
   */
  | "registryMoved"
  /**
   * The other registry could not be asked at all, so "is it really gone?"
   * has no answer. Nothing was written; retryable.
   */
  | "registryUnverified";

/** A life-cycle command that cannot proceed, with a reason worth showing. */
export class DomainLifecycleError extends Error {
  readonly reason: DomainLifecycleErrorReason;
  readonly userMessage: string;

  /**
   * @param {string} reason Why the command cannot proceed.
   * @param {string} userMessage Text the screen may show as-is.
   */
  constructor(
    reason: DomainLifecycleErrorReason,
    userMessage: string,
  ) {
    super(userMessage);
    this.name = "DomainLifecycleError";
    this.reason = reason;
    this.userMessage = userMessage;
  }
}

/** What a delete or restore ended up doing. */
export interface LifecycleResult {
  domainName: string;
  registry: string;
  lifecycle: DomainLifecycle;
  status: string[];
  rgpStatus: string[];
  exDate?: string | null;
  /** True when the domain was already in the target state. */
  alreadyInState: boolean;
  /** Set on delete: what getting it back would cost (FIG.4). */
  restoreFeeYen?: number;
  /** Message intended for the UI, already in Japanese. */
  message: string;
}

/**
 * Reads `domain:info`, treating "not there" as a value rather than an error.
 *
 * @param {RegistryClient} client Registry to ask.
 * @param {string} name Domain name.
 * @param {string} clTRID Transaction id.
 * @return {Promise<DomainInfo | null>} State, or null when it is gone.
 */
async function safeInfo(
  client: RegistryClient,
  name: string,
  clTRID: string,
): Promise<DomainInfo | null> {
  try {
    return await client.infoDomain(name, clTRID);
  } catch (error) {
    if (isRegistryError(error) && error.kind === "objectNotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Builds a unique-enough suffix for a domain-scoped clTRID.
 *
 * @return {string} Short base36 stamp.
 */
function stamp(): string {
  return Date.now().toString(36);
}

/**
 * Whether the registry's current view of a domain still belongs to the
 * member's record.
 *
 * A domain can leave us and come back under someone else with the same name:
 * it expires, and another member re-registers it through this very service.
 * The registry then sees a legitimate command from the sponsoring registrar,
 * so it will not protect the new owner from us — this comparison is the only
 * thing that does. The create flow runs the same check in
 * `recoverExistingDomain` (spec 6.7); delete and restore must not be weaker.
 *
 * Records written by the create flow always carry `registrant`; a record
 * without one predates that and cannot be verified, so it is treated as not
 * ours rather than given the benefit of the doubt.
 *
 * @param {DomainInfo} info Fresh registry state.
 * @param {string | null | undefined} recordRegistrant Contact id on record.
 * @return {boolean} True when the domain is still the member's.
 */
function stillOurs(
  info: DomainInfo,
  recordRegistrant: string | null | undefined,
): boolean {
  return Boolean(recordRegistrant) && info.registrant === recordRegistrant;
}

/** Shown once the mirror has been healed; the member simply tries again. */
const REGISTRY_MOVED_MESSAGE =
  "ドメイン情報を最新の状態に更新しました。お手数ですが、もう一度お試しください。";

/** Shown when the cross-registry check itself could not be completed. */
const REGISTRY_UNVERIFIED_MESSAGE =
  "レジストリの状態を確認できませんでした。時間をおいて再度お試しください。";

/**
 * A cross-registry probe's answer that still allows the mirror to be written
 * off as `gone`.
 */
export type GoneVerdict =
  /** No other registry has the name either: it really was purged. */
  | "purged"
  /** Another registry has it, but under a registrant that is not ours. */
  | "notOurs"
  /** The other registry does not serve this TLD, so it cannot know better. */
  | "unsupported";

/** What one `domain:info` against another registry established. */
type ProbeOutcome =
  | {kind: "migrated"; info: DomainInfo}
  | {kind: "notOurs"}
  | {kind: "purged"}
  | {kind: "unsupported"}
  | {kind: "unverifiable"; error: unknown};

/**
 * Asks one registry — deliberately not the one the mirror names — what it
 * knows about a domain.
 *
 * The client is taken straight from `getRegistryClient`, never through
 * `resolveRegistry`: the whole point of this call is to be independent of the
 * TLD map, whose cache is exactly what goes stale when a registry moves a TLD.
 *
 * @param {RegistryId} probed Registry to ask.
 * @param {string} uid Owner, for the RegistryLog row.
 * @param {string} domainName Domain to ask about.
 * @param {string | null | undefined} registrant Contact id on the mirror.
 * @return {Promise<ProbeOutcome>} What the answer established.
 */
async function probeRegistry(
  probed: RegistryId,
  uid: string,
  domainName: string,
  registrant: string | null | undefined,
): Promise<ProbeOutcome> {
  try {
    const info = await getRegistryClient(probed).infoDomain(
      domainName,
      domainClTrid("PROBE", domainName, stamp()),
      {uid},
    );
    return stillOurs(info, registrant) ?
      {kind: "migrated", info} :
      {kind: "notOurs"};
  } catch (error) {
    if (isRegistryError(error)) {
      // 404 / 2303: this registry has never heard of the name either.
      if (error.kind === "objectNotFound") return {kind: "purged"};
      // 2306 / 422: the registry refuses the TLD outright ("TLD ポリシー違反"
      // in both OpenAPI documents), so its answer is about the TLD and not
      // about the domain. This is the normal-times branch — .com asked of the
      // registry that does not serve .com — and it changes nothing.
      if (error.kind === "policyViolation" || error.kind === "validation") {
        return {kind: "unsupported"};
      }
    }
    return {kind: "unverifiable", error};
  }
}

/**
 * Second opinion before a domain is written off as `gone`.
 *
 * A `domains` record stores the registry it was provisioned at. When a
 * registry hands a TLD over to the other one, every mirror for that TLD names
 * the wrong registry, and the wrong registry answers `domain:info` with a
 * perfectly honest 404 — which delete and restore used to read as "purged"
 * and write into the mirror, destroying the record of a domain that is alive
 * and well next door.
 *
 * So before any of those writes, the OTHER registry is asked directly:
 *
 *   - it has the name, registrant still ours → it migrated. The mirror and
 *     any unfinished order are healed here and a retryable error is thrown,
 *     because the command in flight was aimed at the wrong registry.
 *   - it has the name under another registrant → not ours to protect; the
 *     caller writes `gone`, exactly as `stillOurs` decides elsewhere.
 *   - it does not have the name → truly purged; the caller writes `gone`.
 *   - it refuses the TLD → its 404 says nothing; the original registry's
 *     answer stands and the caller writes `gone`.
 *   - it cannot be reached → nothing is known, so nothing is written and a
 *     retryable error is thrown.
 *
 * Called only on the paths that were about to write `gone`, so the happy path
 * pays nothing for it.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain the command acts on.
 * @param {DomainRecord} record The mirror as it stands.
 * @return {Promise<GoneVerdict>} Returns only when `gone` is safe to write.
 */
export async function confirmGoneAcrossRegistries(
  uid: string,
  domainName: string,
  record: DomainRecord,
): Promise<GoneVerdict> {
  let verdict: GoneVerdict = "purged";
  let unverifiable = false;

  for (const probed of REGISTRY_IDS) {
    if (probed === record.registry) continue;

    const outcome = await probeRegistry(
      probed, uid, domainName, record.registrant);

    if (outcome.kind === "migrated") {
      // Logged at error level on purpose: every line here is one member's
      // domain whose mirror survived a registry-side TLD move only because
      // this check exists, which makes the log the list of records still to
      // be migrated in bulk.
      logger.error("domain found at another registry: mirror was stale", {
        uid,
        domainName,
        mirrorRegistry: record.registry,
        probedRegistry: probed,
        verdict: "migrated",
      });
      await syncDomainRecord(uid, domainName, outcome.info);
      const retargeted = await retargetOpenOrders(
        uid, domainName, outcome.info.registry);
      logger.warn("healed a stale registry mirror", {
        uid,
        domainName,
        mirrorRegistry: record.registry,
        probedRegistry: probed,
        ordersRetargeted: retargeted,
      });
      throw new DomainLifecycleError("registryMoved", REGISTRY_MOVED_MESSAGE);
    }

    if (outcome.kind === "unverifiable") {
      logger.error("cross-registry check failed: not writing gone", {
        uid,
        domainName,
        mirrorRegistry: record.registry,
        probedRegistry: probed,
        verdict: "unverifiable",
        error: String(outcome.error),
      });
      unverifiable = true;
      continue;
    }

    // "someone else's" outranks both "not there" and "not served": it is the
    // most specific thing any registry was able to say about the name.
    if (outcome.kind === "notOurs") verdict = "notOurs";
    else if (verdict === "purged") verdict = outcome.kind;
  }

  if (unverifiable) {
    throw new DomainLifecycleError(
      "registryUnverified", REGISTRY_UNVERIFIED_MESSAGE);
  }
  return verdict;
}

/**
 * Turns the registry's post-command state into a result for the UI.
 *
 * @param {string} name Domain name.
 * @param {string} registry Registry that answered.
 * @param {DomainInfo | null} info Registry state, null when gone.
 * @param {boolean} alreadyInState Whether nothing had to change.
 * @param {string} message Text for the screen.
 * @return {LifecycleResult} Result payload.
 */
function toResult(
  name: string,
  registry: string,
  info: DomainInfo | null,
  alreadyInState: boolean,
  message: string,
): LifecycleResult {
  const lifecycle: DomainLifecycle =
    info === null ? "gone" : lifecycleFromStatus(info.status, info.rgpStatus);
  return {
    domainName: name,
    registry,
    lifecycle,
    status: info?.status ?? ["gone"],
    rgpStatus: info?.rgpStatus ?? [],
    exDate: info?.exDate ?? null,
    alreadyInState,
    restoreFeeYen:
      lifecycle === "pendingDelete" ? priceForRestore(name) : undefined,
    message,
  };
}

/**
 * `domain:delete` — moves the caller's domain to `pendingDelete`.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain to delete.
 * @return {Promise<LifecycleResult>} What the screen should show next.
 */
export async function deleteOwnedDomain(
  uid: string,
  domainName: string,
): Promise<LifecycleResult> {
  const record = await loadOwnedDomain(uid, domainName);
  const client = getRegistryClient(record.registry);

  // Our record already says this is not a live domain. Refresh from the
  // registry rather than issuing a second delete: the record may simply be
  // stale, and a delete against a pendingDelete domain tells us nothing.
  if (record.lifecycle !== "active") {
    const current = await safeInfo(
      client,
      domainName,
      domainClTrid("INFO", domainName, stamp()),
    );
    if (current === null) {
      // Only *this* registry said so, and the record is what decided which
      // registry to ask. Prove the name is not simply living next door.
      await confirmGoneAcrossRegistries(uid, domainName, record);
      await syncDomainRecord(uid, domainName, null);
      return toResult(domainName, record.registry, null, true,
        "このドメインは猶予期間が終了し、すでに失効しています。");
    }
    // The name exists, but is it still this member's? After expiry the same
    // name can be re-registered by someone else — possibly another member of
    // ours, in which case the registry would happily accept our delete. Never
    // write the new owner's data into this record, and never carry on to the
    // delete.
    if (!stillOurs(current, record.registrant)) {
      await syncDomainRecord(uid, domainName, null);
      return toResult(domainName, record.registry, null, true,
        "このドメインはすでにお客様の管理を離れています。");
    }
    await syncDomainRecord(uid, domainName, current);
    // Anything already carrying `pendingDelete` — with or without the
    // `redemptionPeriod` that makes it restorable — is in the delete flow
    // already. Re-issuing the command would only earn a refusal.
    if (current.status.includes("pendingDelete")) {
      return toResult(domainName, record.registry, current, true,
        isRestorable(current.status, current.rgpStatus) ?
          "このドメインはすでに解約手続き中です。" :
          "このドメインは復旧できる期間を過ぎており、まもなく失効します。");
    }
    // The record was stale and the domain is live after all: carry on.
  }

  let deleted: DomainDeleteOutcome;
  try {
    deleted = await client.deleteDomain(
      domainName,
      domainClTrid("DELETE", domainName, stamp()),
      {uid},
    );
  } catch (error) {
    if (isRegistryError(error) && error.kind === "objectNotFound") {
      // Already gone at the registry — or at this registry, which is not the
      // same thing once a TLD has moved house.
      await confirmGoneAcrossRegistries(uid, domainName, record);
      // Same reasoning as spec 6.7: the outcome we wanted is the outcome we
      // have.
      logger.warn("delete found the domain already gone", {uid, domainName});
      await syncDomainRecord(uid, domainName, null);
      return toResult(domainName, record.registry, null, true,
        "このドメインはすでにレジストリから削除されています。");
    }
    throw error;
  }

  const after = await safeInfo(
    client,
    domainName,
    domainClTrid("INFO", domainName, stamp()),
  );
  await syncDomainRecord(uid, domainName, after, {
    deletedAt: FieldValue.serverTimestamp(),
    // The registry's own deadline when it sent one, so the countdown on the
    // list screen is its number rather than ours (gracePeriod.ts derives the
    // fallback). Stored as null rather than skipped, so a second delete after
    // a restore cannot leave the previous deadline behind.
    restorableUntil: deleted.pendingDeleteUntil,
    // A deleted domain must not be picked up by the app-side auto-renew batch
    // (spec 6.4), but the member's own preference is not what changed here —
    // remember it so a restore can put it back exactly as it was.
    autoRenew: false,
    autoRenewBeforeDelete: record.autoRenew ?? true,
  });

  return toResult(domainName, record.registry, after, false,
    after === null ?
      "解約が完了しました。" :
      "解約手続きを受け付けました。猶予期間内であれば復旧できます。");
}

/**
 * What `autoRenew` should be once a restore has succeeded.
 *
 * Delete forces `autoRenew` to false and records what it was beforehand, so
 * the normal answer is simply "whatever the member had chosen".
 *
 * The marker is absent for a domain deleted before it existed. `true` is the
 * documented default for that legacy case: the stored `false` cannot be
 * trusted as a preference, because delete wrote it unconditionally, and a
 * domain the member just paid to bring back should not silently expire at the
 * next `exDate`. The cost of being wrong is an unwanted renewal the member can
 * turn off on the detail screen; the cost of defaulting to `false` is losing
 * the domain for good.
 *
 * @param {boolean | undefined} beforeDelete Marker written by delete.
 * @return {boolean} Flag to store on the restored domain.
 */
function autoRenewAfterRestore(beforeDelete: boolean | undefined): boolean {
  return beforeDelete ?? true;
}

/**
 * `domain:restore` — brings a `pendingDelete` domain back to `ok`.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain to restore.
 * @return {Promise<LifecycleResult>} What the screen should show next.
 */
export async function restoreOwnedDomain(
  uid: string,
  domainName: string,
): Promise<LifecycleResult> {
  const record = await loadOwnedDomain(uid, domainName);
  const client = getRegistryClient(record.registry);

  // Look before restoring. Restore re-activates whatever holds the name
  // right now, so if the name expired and was re-registered-then-deleted by
  // someone else, a blind restore would resurrect *their* domain under this
  // member's click. One extra read on a rare, paid operation is the cheap
  // side of that trade. Delete does not pre-read on its happy path: its
  // records are kept fresh by our own flows, and the stale branch above
  // covers the dangerous case.
  const before = await safeInfo(
    client,
    domainName,
    domainClTrid("INFO", domainName, stamp()),
  );
  if (before === null) {
    await confirmGoneAcrossRegistries(uid, domainName, record);
    await syncDomainRecord(uid, domainName, null);
    throw new DomainLifecycleError("gone",
      "猶予期間が終了しているため復旧できません。");
  }
  if (!stillOurs(before, record.registrant)) {
    await syncDomainRecord(uid, domainName, null);
    throw new DomainLifecycleError("gone",
      "このドメインはすでにお客様の管理を離れています。");
  }
  if (lifecycleFromStatus(before.status, before.rgpStatus) === "active") {
    // Nothing was restored, so nothing about the delete is undone here: the
    // `autoRenew` markers stay as they are. This branch also catches a member
    // calling restore on a domain that was never deleted, and flipping their
    // own auto-renew choice back on would be a change they never asked for.
    await syncDomainRecord(uid, domainName, before);
    return toResult(domainName, record.registry, before, true,
      "このドメインは有効な状態です。復旧の必要はありません。");
  }
  if (!isRestorable(before.status, before.rgpStatus)) {
    // `pendingDelete` without `redemptionPeriod`: the 45 days are over and
    // the registry would answer 2304. Saying so here — from the state we
    // just read — is both faster and clearer than sending a command that is
    // documented to fail, and it keeps the mirror in step with the refusal.
    await syncDomainRecord(uid, domainName, before);
    throw new DomainLifecycleError("notPendingDelete",
      "復旧できる期間が終了しているため、このドメインは元に戻せません。");
  }

  try {
    await client.restoreDomain(
      domainName,
      domainClTrid("RESTORE", domainName, stamp()),
      {uid},
    );
  } catch (error) {
    if (!isRegistryError(error)) throw error;

    if (error.kind === "statusProhibited") {
      // 2304: the domain left `redemptionPeriod` between our pre-read and the
      // restore — either it is live again, or the 45 days ran out in the
      // meantime. If it is simply live already — and still ours — the member
      // got what they asked for.
      const current = await safeInfo(
        client,
        domainName,
        domainClTrid("INFO", domainName, stamp()),
      );
      if (current && stillOurs(current, record.registrant)) {
        await syncDomainRecord(uid, domainName, current);
        if (lifecycleFromStatus(current.status, current.rgpStatus) ===
          "active") {
          return toResult(domainName, record.registry, current, true,
            "このドメインは有効な状態です。復旧の必要はありません。");
        }
      }
      throw new DomainLifecycleError("notPendingDelete",
        "このドメインは復旧できる状態ではありません。");
    }

    if (error.kind === "objectNotFound") {
      await confirmGoneAcrossRegistries(uid, domainName, record);
      await syncDomainRecord(uid, domainName, null);
      throw new DomainLifecycleError("gone",
        "猶予期間が終了しているため復旧できません。");
    }

    if (error.kind === "forbidden") {
      // 403: authenticated fine, but this domain is sponsored by another
      // registrar — it was transferred away, or was never really ours.
      logger.error("restore refused: not the sponsoring registrar",
        {uid, domainName, ...error.toLogPayload()});
      throw new DomainLifecycleError("notSponsored",
        "このドメインは当サービスの管理下にありません。");
    }

    throw error;
  }

  const after = await safeInfo(
    client,
    domainName,
    domainClTrid("INFO", domainName, stamp()),
  );
  // The registry accepted the restore; whether it took effect is a question
  // for the re-read, exactly as on the delete side. Only a domain that is
  // demonstrably live again gets the delete's side effects undone — if it is
  // still pendingDelete, or gone, the markers have to stay so a later attempt
  // still knows what `autoRenew` was before all this started.
  const restored = after !== null &&
    lifecycleFromStatus(after.status, after.rgpStatus) === "active";

  await syncDomainRecord(uid, domainName, after, {
    restoredAt: FieldValue.serverTimestamp(),
    ...(restored ? {
      autoRenew: autoRenewAfterRestore(record.autoRenewBeforeDelete),
      autoRenewBeforeDelete: FieldValue.delete(),
      deletedAt: FieldValue.delete(),
      restorableUntil: FieldValue.delete(),
    } : {}),
  });

  if (after === null) {
    return toResult(domainName, record.registry, after, false,
      "復旧を要求しましたが、レジストリ上でこのドメインは見つかりませんでした。" +
      "猶予期間が終了した可能性があります。");
  }
  if (!restored) {
    return toResult(domainName, record.registry, after, false,
      "復旧を要求しましたが、レジストリではまだ解約手続き中のままです。" +
      "反映まで時間がかかることがあります。しばらくしてからご確認ください。");
  }

  return toResult(domainName, record.registry, after, false,
    "ドメインを復旧しました。");
}
