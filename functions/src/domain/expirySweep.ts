/**
 * The auto-renew-OFF expiry batch (spec 6.4, TBD #15).
 *
 * Neither registry has an OFF switch for auto-renew: spec 3.6 says the
 * registry's own per-minute batch renews every expired domain
 * unconditionally, whatever this service thinks. `autoRenew` therefore only
 * ever lives in the Firestore `domains` mirror (`updateAutoRenew.ts`), and
 * honouring "off" is entirely this app's job — this module is that job.
 *
 * The sweep runs AFTER `exDate`, deliberately losing the race against the
 * registry's own renewal batch rather than trying to win it: the registry's
 * batch fires every minute and there is no way to beat it from outside, but
 * that does not matter, because deleting a freshly auto-renewed domain during
 * its 45-day `autoRenewPeriod` is the documented way to cancel the renewal
 * (RFC 3915 / both OpenAPI documents), not a workaround for missing it. The
 * member keeps the domain until the end of the term they already paid for;
 * only the *next* renewal is what "auto-renew is off" was ever meant to
 * cancel.
 *
 * `deleteOwnedDomain` (domainLifecycle.ts) is reused as-is rather than
 * reimplemented here: a batch-issued delete needs the exact same RGP/mirror
 * semantics as a member clicking "解約" by hand — stale-mirror recovery,
 * re-checking ownership at the registry, recording `autoRenewBeforeDelete`,
 * syncing the mirror to `pendingDelete` — so the domain enters the normal
 * 45-day restore window instead of vanishing instantly. Nothing about "this
 * delete came from a batch, not a click" changes any of that.
 */
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import {deleteOwnedDomain} from "./domainLifecycle";

/** Per-run cap on how many candidate domains are processed, like the poll
 * worker's per-run message cap (`domain/pollWorker.ts`). */
const DEFAULT_MAX_DOMAINS = 25;

/** What one sweep run did. */
export interface ExpirySweepResult {
  /** Candidate domains examined this run (after the `maxDomains` cap). */
  scanned: number;
  /** Domains for which `domain:delete` was issued successfully. */
  deleted: number;
  /** Candidates left untouched: bad/missing `exDate` data. */
  skipped: number;
  /** Candidates whose delete attempt threw. */
  failures: number;
}

/** Options for one sweep run. */
export interface ExpirySweepOptions {
  /** Point in time to compare `exDate` against. Defaults to `new Date()`. */
  now?: Date;
  /** Upper bound on candidates processed per run. */
  maxDomains?: number;
}

/**
 * Parses a stored `exDate` the same permissive way `Date` does, rejecting
 * anything that is not a real timestamp.
 *
 * @param {unknown} exDate Raw `exDate` field from the mirror document.
 * @return {Date | null} Parsed date, or null when it cannot be trusted.
 */
function parseExDate(exDate: unknown): Date | null {
  if (typeof exDate !== "string" || exDate.trim() === "") return null;
  const parsed = new Date(exDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Finds every `autoRenew: false` domain whose term has ended and deletes it.
 *
 * Queried on two plain equality filters — `autoRenew == false` and
 * `lifecycle == "active"` — so no composite index is needed; `exDate` is then
 * compared in code because "past" depends on `now`, which callers may
 * override for testing. `lifecycle == "active"` also keeps a domain already
 * mid-delete (`pendingDelete`) from ever being selected twice.
 *
 * A single domain's failure — a transport error, a registry that already
 * moved the name elsewhere, anything `deleteOwnedDomain` can throw — is
 * isolated so it cannot stop the rest of the run; it is counted in
 * `failures` and logged with enough detail to find the record again.
 *
 * @param {ExpirySweepOptions} options `now` override and per-run cap.
 * @return {Promise<ExpirySweepResult>} Counts describing what the run did.
 */
export async function sweepAutoRenewOff(
  options: ExpirySweepOptions = {},
): Promise<ExpirySweepResult> {
  const now = options.now ?? new Date();
  const maxDomains = options.maxDomains ?? DEFAULT_MAX_DOMAINS;

  const snapshot = await db()
    .collection(COLLECTIONS.domains)
    .where("autoRenew", "==", false)
    .where("lifecycle", "==", "active")
    .limit(maxDomains + 1)
    .get();

  const truncated = snapshot.docs.length > maxDomains;
  const candidates = truncated ?
    snapshot.docs.slice(0, maxDomains) :
    snapshot.docs;

  if (truncated) {
    logger.warn("expiry sweep hit its per-run cap; more candidates remain", {
      maxDomains,
    });
  }

  const result: ExpirySweepResult = {
    scanned: candidates.length,
    deleted: 0,
    skipped: 0,
    failures: 0,
  };

  for (const doc of candidates) {
    const data = doc.data();
    const uid = data.uid as string | undefined;
    const domainName = data.name as string | undefined;

    if (!uid || !domainName) {
      // Should not happen — every write path sets both — but a delete needs
      // both to even ask `loadOwnedDomain`, so this cannot be recovered here.
      result.skipped++;
      logger.warn("expiry sweep: candidate missing uid/name", {
        docId: doc.id,
      });
      continue;
    }

    const exDate = parseExDate(data.exDate);
    if (exDate === null) {
      // Never delete on data we cannot trust.
      result.skipped++;
      logger.warn("expiry sweep: candidate has no usable exDate", {
        uid,
        domainName,
      });
      continue;
    }
    if (exDate.getTime() > now.getTime()) {
      // Not due yet: neither a delete nor a skip, just not selected this run.
      continue;
    }

    try {
      await deleteOwnedDomain(uid, domainName);
      result.deleted++;
    } catch (error) {
      result.failures++;
      logger.error("expiry sweep: delete failed for one domain", {
        uid,
        domainName,
        error: String(error),
      });
    }
  }

  logger.info("expiry sweep finished", {...result});
  return result;
}
