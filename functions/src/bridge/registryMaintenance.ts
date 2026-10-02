/**
 * Per-registry maintenance state, announced by the registry itself.
 *
 * registryHealth.ts infers an outage from sustained 503s — a judgement that
 * can never say *why* the registry is down, which is exactly why the UI is
 * forbidden to claim "メンテナンス" from a 503 alone
 * (docs/仕様/registry-unavailable.md §1). This module holds the one signal
 * that IS allowed to make that claim: a maintenance notification received
 * over the poll queue *before* the window starts (during the window the poll
 * endpoint itself answers 503, so the announcement necessarily arrives in
 * advance).
 *
 * The state lives in Firestore so every function instance shares it, exactly
 * like the circuit breaker:
 *
 *   counters/registryMaintenance_{registry}
 *     active       whether an announced window is still standing
 *     windowStart  announced start, when the payload carried one
 *     windowEnd    announced end, when the payload carried one
 *     msgId/msgType/note/rawPayload   provenance, for debugging the
 *                  undocumented message shape
 *     lastProbeAt  latest probe while blocked with no announced end
 *
 * Gate behaviour, per the agreed lifecycle:
 *   - before windowStart: traffic flows normally (the registry is still up)
 *   - inside the window:  fail fast with NO probes — the whole point is to
 *     stop the circuit breaker's pointless reconnects during announced
 *     maintenance
 *   - after windowEnd:    stop blocking; the record stays until a real
 *     answer from the registry proves it is back, then it is cleared
 *   - no windowEnd given: block, but probe every PROBE_INTERVAL_MS like the
 *     circuit breaker, since time alone can never end the window
 *
 * Every judgement error in here fails towards "none": maintenance tracking
 * must never be the thing that breaks a command.
 */
import * as logger from "firebase-functions/logger";
import {Timestamp} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {PROBE_INTERVAL_MS} from "./registryHealth";

/** What the maintenance gate tells EppClient to do with the next command. */
export type MaintenanceGate =
  /** No standing maintenance: proceed as normal. */
  | {decision: "none"}
  /** Announced but not started yet: proceed as normal. */
  | {decision: "pending"}
  /** Inside (or in an unbounded) window: fail fast without connecting. */
  | {decision: "blocked"; until: string | null}
  /** Unbounded window, probe slot claimed: go ahead and try. */
  | {decision: "probe"};

/** Wire shape of the maintenance document. */
interface MaintenanceDoc {
  active: boolean;
  windowStart: Timestamp | null;
  windowEnd: Timestamp | null;
  msgId: string | null;
  msgType: string | null;
  note: string | null;
  rawPayload: Record<string, unknown> | null;
  announcedAt: Timestamp | null;
  lastProbeAt: Timestamp | null;
  clearedAt: Timestamp | null;
  clearedBy: "notification" | "contact" | null;
}

/**
 * Last verdict this process saw, so the hot success path
 * (noteRegistryAnswered after every healthy command) never reads Firestore
 * while no maintenance is standing.
 */
const lastKnownInactive: Partial<Record<RegistryId, boolean>> = {};

/**
 * Document id of one registry's maintenance record. Exported so tests can
 * seed the document directly.
 *
 * @param {RegistryId} registry Registry the record belongs to.
 * @return {string} Document id inside COLLECTIONS.counters.
 */
export function maintenanceDocId(registry: RegistryId): string {
  return `registryMaintenance_${registry}`;
}

/**
 * Reference to one registry's maintenance document.
 *
 * @param {RegistryId} registry Registry the record belongs to.
 * @return {FirebaseFirestore.DocumentReference} Firestore reference.
 */
function maintenanceRef(registry: RegistryId) {
  return db().collection(COLLECTIONS.counters).doc(maintenanceDocId(registry));
}

/** What a parsed notification says the window looks like. */
export interface MaintenanceWindow {
  windowStart: Date | null;
  windowEnd: Date | null;
  msgId: string | null;
  msgType: string | null;
  note: string | null;
  rawPayload: Record<string, unknown> | null;
}

/**
 * Records an announced maintenance window.
 *
 * A later announcement for the same registry replaces the earlier one
 * wholesale: the registry's newest word wins.
 *
 * @param {RegistryId} registry Registry the announcement is about.
 * @param {MaintenanceWindow} window Parsed announcement.
 * @return {Promise<void>} Resolves once written.
 */
export async function setMaintenance(
  registry: RegistryId,
  window: MaintenanceWindow,
): Promise<void> {
  lastKnownInactive[registry] = false;
  await maintenanceRef(registry).set({
    active: true,
    windowStart: window.windowStart ?
      Timestamp.fromDate(window.windowStart) : null,
    windowEnd: window.windowEnd ? Timestamp.fromDate(window.windowEnd) : null,
    msgId: window.msgId,
    msgType: window.msgType,
    note: window.note,
    rawPayload: window.rawPayload,
    announcedAt: Timestamp.now(),
    lastProbeAt: null,
    clearedAt: null,
    clearedBy: null,
  });
  logger.info("registryMaintenance: window recorded", {
    registry,
    windowStart: window.windowStart?.toISOString() ?? null,
    windowEnd: window.windowEnd?.toISOString() ?? null,
    msgId: window.msgId,
  });
}

/**
 * Clears the standing maintenance record.
 *
 * @param {RegistryId} registry Registry that is back (or was never down).
 * @param {"notification" | "contact"} clearedBy What proved it: an explicit
 *   end-of-maintenance notification, or a real answer from the registry.
 * @return {Promise<void>} Resolves once written (or skipped).
 */
export async function clearMaintenance(
  registry: RegistryId,
  clearedBy: "notification" | "contact",
): Promise<void> {
  lastKnownInactive[registry] = true;
  await maintenanceRef(registry)
    .set(
      {active: false, clearedAt: Timestamp.now(), clearedBy},
      {merge: true},
    )
    .catch((error) => {
      lastKnownInactive[registry] = undefined;
      logger.warn("registryMaintenance: failed to clear", {
        registry, error: String(error),
      });
    });
  logger.info("registryMaintenance: cleared", {registry, clearedBy});
}

/**
 * Decides whether announced maintenance stops the next command.
 *
 * @param {RegistryId} registry Registry about to be called.
 * @return {Promise<MaintenanceGate>} What to do with the command.
 */
export async function checkMaintenanceGate(
  registry: RegistryId,
): Promise<MaintenanceGate> {
  // No cache short-circuit here, deliberately: the window is usually recorded
  // by ANOTHER process (the poll worker, or the dev callable), so a cached
  // "inactive" verdict in this one would make every announcement invisible
  // until a cold start. The gate always reads Firestore, exactly like the
  // circuit breaker's checkGate; the cache only spares noteRegistryAnswered.
  let data: MaintenanceDoc | undefined;
  try {
    data = (await maintenanceRef(registry).get()).data() as
      MaintenanceDoc | undefined;
  } catch (error) {
    logger.warn("registryMaintenance: gate read failed, treating as none",
      {registry, error: String(error)});
    return {decision: "none"};
  }

  if (!data?.active) {
    lastKnownInactive[registry] = true;
    return {decision: "none"};
  }
  lastKnownInactive[registry] = false;

  const now = Date.now();
  const startMs = data.windowStart?.toMillis();
  const endMs = data.windowEnd?.toMillis();

  if (startMs !== undefined && now < startMs) return {decision: "pending"};

  if (endMs !== undefined) {
    // Past the announced end the claim "メンテナンス中" is no longer honest;
    // traffic resumes and the record waits for a real answer to clear it
    // (noteRegistryAnswered).
    return now < endMs ?
      {decision: "blocked", until: data.windowEnd?.toDate().toISOString() ??
        null} :
      {decision: "none"};
  }

  // No announced end: time alone can never end the window, so probe like the
  // circuit breaker does. Best-effort claim; a race lets a few extra probes
  // through, which is harmless.
  const lastProbeMs = data.lastProbeAt?.toMillis() ?? 0;
  if (now - lastProbeMs < PROBE_INTERVAL_MS) {
    return {decision: "blocked", until: null};
  }
  await maintenanceRef(registry)
    .set({lastProbeAt: Timestamp.now()}, {merge: true})
    .catch((error) => logger.warn(
      "registryMaintenance: probe claim failed",
      {registry, error: String(error)},
    ));
  return {decision: "probe"};
}

/**
 * Records that the registry actually answered (any HTTP status: even a
 * business 4xx proves it is reachable), clearing a standing record whose
 * window is over.
 *
 * An answer *before* the announced start deliberately clears nothing: the
 * registry is expected to be up until then, so a success says nothing about
 * the announcement.
 *
 * @param {RegistryId} registry Registry that answered.
 * @return {Promise<void>} Resolves once recorded (or skipped).
 */
export async function noteRegistryAnswered(
  registry: RegistryId,
): Promise<void> {
  if (lastKnownInactive[registry] === true) return;

  let data: MaintenanceDoc | undefined;
  try {
    data = (await maintenanceRef(registry).get()).data() as
      MaintenanceDoc | undefined;
  } catch {
    return;
  }
  if (!data?.active) {
    lastKnownInactive[registry] = true;
    return;
  }

  const now = Date.now();
  const startMs = data.windowStart?.toMillis();
  const endMs = data.windowEnd?.toMillis();
  const windowOver = endMs !== undefined ?
    now >= endMs :
    startMs === undefined || now >= startMs;
  if (windowOver) await clearMaintenance(registry, "contact");
}

/** Read-only view of one registry's record, for the dev panel. */
export interface MaintenanceSummary {
  active: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  msgType: string | null;
  note: string | null;
}

/**
 * Current record for one registry, without side effects.
 *
 * Deliberately NOT checkMaintenanceGate: the gate claims the probe slot of
 * an unbounded window, so a status poll through it would starve the real
 * probe (the "二重ゲート" trap the poll worker already avoids).
 *
 * @param {RegistryId} registry Registry to look up.
 * @return {Promise<MaintenanceSummary>} Stored record; inactive when unset
 *   or unreadable.
 */
export async function maintenanceSummary(
  registry: RegistryId,
): Promise<MaintenanceSummary> {
  const inactive: MaintenanceSummary = {
    active: false, windowStart: null, windowEnd: null,
    msgType: null, note: null,
  };
  try {
    const data = (await maintenanceRef(registry).get()).data() as
      MaintenanceDoc | undefined;
    if (!data?.active) return inactive;
    return {
      active: true,
      windowStart: data.windowStart?.toDate().toISOString() ?? null,
      windowEnd: data.windowEnd?.toDate().toISOString() ?? null,
      msgType: data.msgType ?? null,
      note: data.note ?? null,
    };
  } catch {
    return inactive;
  }
}

/** Clears the per-process cache. Test helper. */
export function resetMaintenanceCache(): void {
  delete lastKnownInactive.kitaqsign;
  delete lastKnownInactive.kitaqnic;
}
