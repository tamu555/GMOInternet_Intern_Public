/**
 * The pending-transfer reconciler (docs/FIXME/TODO.md §4, spec 6.6.1).
 *
 * Both registries deliver each transfer notification to exactly one side:
 * `request`/`cancel` to the losing registrar, `approve`/`reject` to the
 * gaining one. The 20-minute auto-approve is no exception — so when a member
 * ignores an inbound request, the domain leaves and *nothing tells us*. The
 * only way to notice is to ask: re-read `domain:info` for every transfer
 * still `pending` and write back what the registry says.
 *
 * Evidence table for a pending *outbound* transfer (we are losing):
 *
 * | probe                                    | verdict                     |
 * |------------------------------------------|-----------------------------|
 * | absent (404) / unreadable for us (403)   | the domain left us          |
 * | readable, `pendingTransfer` still set    | still waiting               |
 * | readable, gone, `transferPeriod` present | approved behind our back    |
 * | readable, gone, no `transferPeriod`      | ended without transferring  |
 *
 * `transferPeriod` (RFC 3915, set for 45 days after a transfer) is what makes
 * the third row provable even on a registry that still lets the old sponsor
 * read the domain. The last row is only settled after the auto-approve
 * deadline has passed, because before it a `cancel` notification may simply
 * not have arrived yet.
 *
 * This also sweeps mirrors stuck in `pendingDelete` (TODO §3): the registry
 * purges silently when the grace period ends, so those are re-read the same
 * way.
 *
 * Runs after every queue drain — the scheduled worker and the manual
 * `drainPollQueue` Callable — so "poll then reconcile" is one heartbeat.
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import {getRegistryClient} from "../bridge/registryRouter";
import {isRegistryError} from "../bridge/errors";
import type {RegistryClient} from "../bridge/registryClient";
import type {DomainInfo} from "../bridge/types";
import {domainClTrid} from "./clTrid";
import {syncDomainRecord, type DomainRecord} from "./domainRecords";
import {
  claimTransfer,
  listPendingTransfersAcrossMembers,
  normaliseRegistryTimestamp,
  settleTransfer,
  releaseTransferClaim,
  type TransferRecord,
  type TransferState,
} from "./transfers";

const PENDING_TRANSFER_STATUS = "pendingTransfer";
const TRANSFER_PERIOD_STATUS = "transferPeriod";
/** Two poll cycles: an inbound `approve` notification gets to arrive first. */
const INBOUND_REJECT_SLACK_MS = 10 * 60_000;
/** JST, which both registries stamp in (one of them mislabelled as `Z`). */
const JST_OFFSET_MS = 9 * 60 * 60_000;

/** Upper bound on records looked at per run, per sweep. */
const DEFAULT_LIMIT = 25;

/** What one reconciler run did. */
export interface ReconcileSummary {
  /** Pending transfers examined. */
  checked: number;
  /** Settled as completed: the domain provably left (or arrived). */
  completed: number;
  /** Settled as cancelled/rejected: the window closed without a transfer. */
  closed: number;
  /** Mirrors refreshed without settling anything. */
  refreshed: number;
  /** Pending-delete mirrors examined. */
  mirrorsChecked: number;
  /** Pending-delete mirrors that turned out to be purged. */
  mirrorsGone: number;
  /** Records skipped because a member's own command held them. */
  busy: number;
  /** Probe or write failures, each logged. */
  errors: number;
}

/** How a probe of one domain came back. */
type Probe =
  | {kind: "info"; info: DomainInfo}
  | {kind: "absent"}
  | {kind: "unreadable"};

/**
 * Reads `domain:info`, folding the two "we cannot see it" answers into
 * values instead of exceptions.
 *
 * @param {RegistryClient} client Registry to ask.
 * @param {string} domainName Domain to read.
 * @return {Promise<Probe>} What the registry let us see.
 */
async function probe(
  client: RegistryClient,
  domainName: string,
): Promise<Probe> {
  try {
    const info = await client.infoDomain(
      domainName,
      domainClTrid("INFO", domainName, Date.now().toString(36)),
    );
    return {kind: "info", info};
  } catch (error) {
    if (isRegistryError(error)) {
      if (error.kind === "objectNotFound") return {kind: "absent"};
      if (error.kind === "forbidden") return {kind: "unreadable"};
    }
    throw error;
  }
}

/**
 * Whether the auto-approve deadline stored on a record has passed.
 *
 * A missing or unparsable deadline counts as passed: such a record has been
 * pending since before deadlines were recorded, which is longer than any
 * real 20-minute window.
 *
 * @param {TransferRecord} record Record being reconciled.
 * @param {number} slackMs Extra grace after the deadline before it counts.
 * @return {boolean} True when the registry can no longer be waiting on us.
 */
function deadlinePassed(record: TransferRecord, slackMs = 0): boolean {
  const raw = record.data.autoApproveAt;
  if (!raw) return true;
  const at = Date.parse(String(raw));
  return Number.isNaN(at) ? true : at + slackMs <= Date.now();
}

/**
 * Reads a registry timestamp as an instant, correcting the registries' zone
 * quirks: kitaqsign omits the designator, kitaqnic labels JST as `Z`. A stamp
 * that lands in the future is therefore JST mislabelled, and is shifted back.
 *
 * @param {string | null | undefined} value Timestamp as the registry spelt it.
 * @return {number} Epoch milliseconds, or NaN when absent/unparseable.
 */
function registryInstant(value: string | null | undefined): number {
  if (!value) return NaN;
  const parsed = Date.parse(normaliseRegistryTimestamp(String(value)));
  if (Number.isNaN(parsed)) return NaN;
  return parsed > Date.now() + 60_000 ? parsed - JST_OFFSET_MS : parsed;
}

/**
 * The verdict a probe supports for one pending transfer, if any.
 *
 * @param {TransferRecord} record Record being reconciled.
 * @param {Probe} seen What `domain:info` answered.
 * @param {string | null} memberContactId The member's contact id, for the
 *   inbound "is it ours now" check; null when unknown.
 * @return {TransferState | "refresh" | null} State to settle into, `refresh`
 *   to only update the mirror, or null to leave the record alone.
 */
function verdict(
  record: TransferRecord,
  seen: Probe,
  memberContactId: string | null,
): TransferState | "refresh" | null {
  const direction = record.data.direction;

  if (direction === "out") {
    if (seen.kind === "absent" || seen.kind === "unreadable") {
      // We can no longer see a domain we sponsored: it left us. (A domain
      // that was purged instead is equally gone from the member's list.)
      return "completed";
    }
    const status = seen.info.status ?? [];
    if (status.includes(PENDING_TRANSFER_STATUS)) return "refresh";
    if ((seen.info.rgpStatus ?? []).includes(TRANSFER_PERIOD_STATUS)) {
      return "completed";
    }
    // Window closed, domain still here, no transfer stamp: the request was
    // rejected or withdrawn and the notification never reached us. Only
    // settled once the registry can no longer be waiting on our answer.
    return deadlinePassed(record) ? "cancelled" : "refresh";
  }

  // Inbound: approve/reject normally arrive by poll, so this is a backstop.
  if (seen.kind !== "info") return null;
  const status = seen.info.status ?? [];
  if (status.includes(PENDING_TRANSFER_STATUS)) return null;
  // A transfer moves the sponsorship, never the registrant contact, so the
  // registrant check alone can never prove an inbound transfer landed. The
  // registry does stamp the domain: `transferPeriod` in rgpStatus and a
  // `trDate` at or after our request are both hard evidence it is ours now.
  if ((seen.info.rgpStatus ?? []).includes(TRANSFER_PERIOD_STATUS)) {
    return "completed";
  }
  const trDate = registryInstant(seen.info.trDate);
  const requestedAt = record.data.requestedAt ?
    Date.parse(String(record.data.requestedAt)) : NaN;
  if (!Number.isNaN(trDate) &&
      (Number.isNaN(requestedAt) || trDate >= requestedAt - 60_000)) {
    return "completed";
  }
  if (memberContactId && seen.info.registrant === memberContactId) {
    return "completed";
  }
  // No stamp and no `pendingTransfer`: the losing side rejected, or the
  // `approve` poll message is still queued. Only give up once the poll
  // worker has had a full cycle past the deadline to deliver it.
  return deadlinePassed(record, INBOUND_REJECT_SLACK_MS) ? "rejected" : null;
}

/**
 * Reads the member's registry contact id, for the inbound ownership check.
 *
 * @param {string} uid Firebase Authentication uid.
 * @return {Promise<string | null>} Contact id, or null when absent.
 */
async function memberContactId(uid: string): Promise<string | null> {
  const snapshot = await db().collection(COLLECTIONS.users).doc(uid).get();
  const id = snapshot.data()?.contactId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Settles one reconciled transfer and brings the mirror in line with it.
 *
 * @param {TransferRecord} record Claimed record.
 * @param {string} token Claim token.
 * @param {TransferState} state Where the evidence says the transfer ended.
 * @param {Probe} seen The probe that produced the verdict.
 * @return {Promise<void>} Resolves once both writes settled.
 */
async function settle(
  record: TransferRecord,
  token: string,
  state: TransferState,
  seen: Probe,
): Promise<void> {
  await settleTransfer(record, token, {state, error: null});

  const {uid, domainName, direction} = record.data;
  if (direction === "out") {
    if (state === "completed") {
      await syncDomainRecord(uid, domainName, null, {
        transferredAt: FieldValue.serverTimestamp(),
        autoRenew: false,
      });
    } else if (seen.kind === "info") {
      await syncDomainRecord(uid, domainName, seen.info);
    }
    return;
  }
  if (state === "completed" && seen.kind === "info") {
    await syncDomainRecord(uid, domainName, seen.info, {
      registry: record.data.registry,
      autoRenew: true,
    });
  }
}

/**
 * Reconciles every pending transfer against the registry (TODO §4).
 *
 * @param {number} limit Upper bound on records examined.
 * @return {Promise<ReconcileSummary>} What the run did.
 */
export async function reconcilePendingTransfers(
  limit: number = DEFAULT_LIMIT,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    checked: 0, completed: 0, closed: 0, refreshed: 0,
    mirrorsChecked: 0, mirrorsGone: 0, busy: 0, errors: 0,
  };

  const pending = await listPendingTransfersAcrossMembers(limit);
  for (const record of pending) {
    summary.checked++;
    const {uid, domainName, registry, direction} = record.data;
    try {
      const client = getRegistryClient(registry);
      const seen = await probe(client, domainName);
      const contact =
        direction === "in" ? await memberContactId(uid) : null;
      const outcome = verdict(record, seen, contact);

      if (outcome === null) continue;
      if (outcome === "refresh") {
        if (seen.kind === "info" && direction === "out") {
          await syncDomainRecord(uid, domainName, seen.info);
          summary.refreshed++;
        }
        continue;
      }

      const claim = await claimTransfer({
        uid,
        domainName,
        registry,
        direction,
        allowedStates: ["pending"],
        expectDirection: direction,
        openIfMissing: false,
      });
      if (claim.status !== "claimed") {
        // A member's own command is mid-flight, or the state moved since the
        // query. Their conclusion wins; this run simply steps aside.
        summary.busy++;
        continue;
      }
      try {
        await settle(claim.record, claim.token, outcome, seen);
      } catch (error) {
        await releaseTransferClaim(claim.record, claim.token);
        throw error;
      }
      if (outcome === "completed") summary.completed++;
      else summary.closed++;
      logger.info("reconciled a pending transfer", {
        uid, domainName, registry, direction, outcome,
      });
    } catch (error) {
      summary.errors++;
      logger.error("could not reconcile a pending transfer", {
        uid, domainName, registry, error: String(error),
      });
    }
  }

  await sweepPendingDeleteMirrors(summary, limit);
  return summary;
}

/**
 * Re-reads every mirror still in `pendingDelete` (TODO §3): the registry
 * purges silently when the grace period ends, and `redemptionPeriod` can
 * drop without any notification either.
 *
 * @param {ReconcileSummary} summary Run summary to add to.
 * @param {number} limit Upper bound on mirrors examined.
 * @return {Promise<void>} Resolves once the sweep finished.
 */
async function sweepPendingDeleteMirrors(
  summary: ReconcileSummary,
  limit: number,
): Promise<void> {
  const snapshot = await db()
    .collection(COLLECTIONS.domains)
    .where("lifecycle", "==", "pendingDelete")
    .limit(limit)
    .get();

  for (const doc of snapshot.docs) {
    summary.mirrorsChecked++;
    const mirror = doc.data() as DomainRecord;
    try {
      const client = getRegistryClient(mirror.registry);
      const seen = await probe(client, mirror.name);
      if (seen.kind === "absent" || seen.kind === "unreadable") {
        await syncDomainRecord(mirror.uid, mirror.name, null);
        summary.mirrorsGone++;
        continue;
      }
      // Same ownership rule as delete/restore: never write another owner's
      // registry data into this member's record.
      if (mirror.registrant && seen.info.registrant !== mirror.registrant) {
        await syncDomainRecord(mirror.uid, mirror.name, null);
        summary.mirrorsGone++;
        continue;
      }
      await syncDomainRecord(mirror.uid, mirror.name, seen.info);
    } catch (error) {
      summary.errors++;
      logger.error("could not refresh a pendingDelete mirror", {
        uid: mirror.uid, domainName: mirror.name, error: String(error),
      });
    }
  }
}
