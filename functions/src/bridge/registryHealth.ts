/**
 * Per-registry health judgement across requests (a small circuit breaker).
 *
 * One 503 says almost nothing: the registry may be restarting, overloaded or
 * in maintenance, and the very next request may succeed. What the UI is
 * allowed to claim ("一時的に購入できません") therefore hinges on a judgement
 * no single request can make: 503s sustained for OUTAGE_WINDOW_MS with no
 * success in between (docs/仕様/registry-unavailable.md).
 *
 * The state lives in Firestore so every function instance shares the same
 * verdict, mirroring how the TLD map is shared (registryRouter.ts):
 *
 *   counters/registryHealth_{registry}
 *     state          "ok" | "unavailable"
 *     consecutive503 failures since the last success
 *     firstFailureAt start of the current 503 streak
 *     lastFailureAt  latest 503
 *     lastProbeAt    latest half-open probe while unavailable
 *
 * While "unavailable" the gate answers "open" and EppClient fails fast
 * without touching the registry — except once every PROBE_INTERVAL_MS, when
 * a single request is let through ("probe") so a recovered registry closes
 * the circuit on its own. Every judgement error in here fails towards
 * "closed": health tracking must never be the thing that breaks a command.
 */
import * as logger from "firebase-functions/logger";
import {Timestamp} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";

/** 503s must span this long, uninterrupted, before the circuit opens. */
export const OUTAGE_WINDOW_MS = 60_000;

/** While open, one real request is allowed through this often. */
export const PROBE_INTERVAL_MS = 30_000;

/** What the gate tells EppClient to do with the next command. */
export type GateDecision = "closed" | "open" | "probe";

/** Wire shape of the health document. */
interface HealthDoc {
  state: "ok" | "unavailable";
  consecutive503: number;
  firstFailureAt: Timestamp | null;
  lastFailureAt: Timestamp | null;
  lastProbeAt: Timestamp | null;
}

/**
 * Last state this process saw, so the hot success path (recordSuccess after
 * every healthy command) never writes Firestore.
 */
const lastKnownOk: Partial<Record<RegistryId, boolean>> = {};

/**
 * Document id of one registry's health record. Exported so tests can seed
 * the document directly instead of waiting a real minute.
 *
 * @param {RegistryId} registry Registry the record belongs to.
 * @return {string} Document id inside COLLECTIONS.counters.
 */
export function healthDocId(registry: RegistryId): string {
  return `registryHealth_${registry}`;
}

/**
 * Reference to one registry's health document.
 *
 * @param {RegistryId} registry Registry the record belongs to.
 * @return {FirebaseFirestore.DocumentReference} Firestore reference.
 */
function healthRef(registry: RegistryId) {
  return db().collection(COLLECTIONS.counters).doc(healthDocId(registry));
}

/**
 * Decides whether the next command may reach the registry.
 *
 * @param {RegistryId} registry Registry about to be called.
 * @return {Promise<GateDecision>} "closed" (go ahead), "open" (fail fast) or
 *   "probe" (go ahead, and your outcome decides whether the circuit closes).
 */
export async function checkGate(registry: RegistryId): Promise<GateDecision> {
  let data: HealthDoc | undefined;
  try {
    data = (await healthRef(registry).get()).data() as HealthDoc | undefined;
  } catch (error) {
    logger.warn("registryHealth: gate read failed, treating as closed",
      {registry, error: String(error)});
    return "closed";
  }

  if (!data || data.state !== "unavailable") {
    lastKnownOk[registry] = true;
    return "closed";
  }

  // Without this, an instance that cached "ok" before the outage would skip
  // the recordSuccess write after a successful probe — and the circuit would
  // never close.
  lastKnownOk[registry] = false;

  const lastProbeMs = data.lastProbeAt?.toMillis() ?? 0;
  if (Date.now() - lastProbeMs < PROBE_INTERVAL_MS) return "open";

  // Claim the probe slot. Best-effort: a race between instances lets a few
  // extra probes through, which is harmless.
  await healthRef(registry)
    .set({lastProbeAt: Timestamp.now()}, {merge: true})
    .catch((error) => logger.warn("registryHealth: probe claim failed",
      {registry, error: String(error)}));
  return "probe";
}

/**
 * Records one 503 and answers whether the circuit is now open.
 *
 * The first 503 of a streak can never open the circuit (its own timestamp
 * starts the window), so a lone blip is never escalated.
 *
 * @param {RegistryId} registry Registry that answered 503.
 * @return {Promise<{circuitOpen: boolean}>} Verdict after this failure.
 */
export async function record503(
  registry: RegistryId,
): Promise<{circuitOpen: boolean}> {
  lastKnownOk[registry] = false;
  try {
    return await db().runTransaction(async (tx) => {
      const ref = healthRef(registry);
      const data = (await tx.get(ref)).data() as HealthDoc | undefined;
      const now = Timestamp.now();
      const first = data?.firstFailureAt ?? now;
      const open = data?.state === "unavailable" ||
        now.toMillis() - first.toMillis() >= OUTAGE_WINDOW_MS;
      tx.set(ref, {
        state: open ? "unavailable" : "ok",
        consecutive503: (data?.consecutive503 ?? 0) + 1,
        firstFailureAt: first,
        lastFailureAt: now,
        lastProbeAt: data?.lastProbeAt ?? null,
      });
      return {circuitOpen: open};
    });
  } catch (error) {
    logger.warn("registryHealth: failed to record 503",
      {registry, error: String(error)});
    return {circuitOpen: false};
  }
}

/**
 * Records a healthy answer, closing the circuit if it was open.
 *
 * @param {RegistryId} registry Registry that answered normally.
 * @return {Promise<void>} Resolves once recorded (or skipped).
 */
export async function recordSuccess(registry: RegistryId): Promise<void> {
  if (lastKnownOk[registry] === true) return;
  lastKnownOk[registry] = true;
  await healthRef(registry).set({
    state: "ok",
    consecutive503: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    lastProbeAt: null,
  }).catch((error) => {
    lastKnownOk[registry] = undefined;
    logger.warn("registryHealth: failed to record success",
      {registry, error: String(error)});
  });
}

/**
 * Current judgement for one registry, for the dev panel.
 *
 * @param {RegistryId} registry Registry to look up.
 * @return {Promise<"ok" | "unavailable">} Stored state; "ok" when unset.
 */
export async function healthState(
  registry: RegistryId,
): Promise<"ok" | "unavailable"> {
  try {
    const data = (await healthRef(registry).get()).data() as
      HealthDoc | undefined;
    return data?.state === "unavailable" ? "unavailable" : "ok";
  } catch {
    return "ok";
  }
}

/** Clears the per-process cache. Test helper. */
export function resetHealthCache(): void {
  delete lastKnownOk.kitaqsign;
  delete lastKnownOk.kitaqnic;
}
