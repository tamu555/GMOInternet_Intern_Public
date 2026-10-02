/**
 * Emulator-only fault injection: force 503 answers per registry.
 *
 * The dev panel (frontend/src/dev/MockControlPanel.tsx) flips these flags via
 * the `devForceRegistry503` callable; EppClient.attempt() consults them and,
 * when set, synthesises an HTTP 503 without touching the registry. Everything
 * downstream — the two-stage judgement, RegistryLog, registryHealth — then
 * behaves exactly as in a real outage, which is the point: this is the
 * "故障注入スイッチ" of spec §10.2 and the demo lever of spec §12.
 *
 * Every flag self-expires FORCE_503_TTL_MS after it was switched on. The
 * emulator's Firestore state is shared across branches and can survive (or
 * be resurrected by) container restarts via the export/import volume, so a
 * forgotten switch used to keep poisoning everyone else's sessions with
 * mystery 503s. The expiry is judged at read time — no TTL policy, no extra
 * reads or deletes — and a flag without an expiry (a stale snapshot from
 * before this rule) counts as off, so old exports self-heal.
 *
 * Outside the emulator every helper here is inert: the flag is never read
 * (fetch happens normally) and the callable refuses to write. The gate is
 * the same FUNCTIONS_EMULATOR check config/firebase.ts uses.
 */
import * as logger from "firebase-functions/logger";
import {Timestamp} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";

/** Document holding the per-registry flags. */
export const FORCE_503_DOC = "devForce503";

/** How long a switched-on flag stays on before it expires on its own. */
export const FORCE_503_TTL_MS = 30 * 60_000;

/** Effective on/off answer per registry, expiry already applied. */
export interface Force503Flags {
  kitaqsign: boolean;
  kitaqnic: boolean;
}

/** Flags plus when each active one switches itself off (ISO, null if off). */
export interface Force503State {
  flags: Force503Flags;
  expiresAt: {kitaqsign: string | null; kitaqnic: string | null};
}

/** Wire shape of the flag document. */
interface Force503Doc {
  kitaqsign?: boolean;
  kitaqnic?: boolean;
  kitaqsignExpiresAt?: Timestamp | null;
  kitaqnicExpiresAt?: Timestamp | null;
}

/**
 * Whether this process runs inside the Firebase emulator.
 *
 * @return {boolean} True in the local emulator, false everywhere else.
 */
export function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true";
}

/**
 * Reference to the flag document.
 *
 * @return {FirebaseFirestore.DocumentReference} Firestore reference.
 */
function flagRef() {
  return db().collection(COLLECTIONS.counters).doc(FORCE_503_DOC);
}

/**
 * Reads both flags with their expiries. Missing document, missing expiry or
 * a past expiry all mean "nothing forced".
 *
 * @return {Promise<Force503State>} Current flags and expiries.
 */
export async function readForce503State(): Promise<Force503State> {
  const state: Force503State = {
    flags: {kitaqsign: false, kitaqnic: false},
    expiresAt: {kitaqsign: null, kitaqnic: null},
  };
  let data: Force503Doc | undefined;
  try {
    data = (await flagRef().get()).data() as Force503Doc | undefined;
  } catch (error) {
    logger.warn("force503: flag read failed, treating as off",
      {error: String(error)});
    return state;
  }
  if (!data) return state;

  const expiries: Record<RegistryId, Timestamp | null | undefined> = {
    kitaqsign: data.kitaqsignExpiresAt,
    kitaqnic: data.kitaqnicExpiresAt,
  };
  for (const registry of ["kitaqsign", "kitaqnic"] as const) {
    const expires = expiries[registry];
    const active = data[registry] === true &&
      expires != null && expires.toMillis() > Date.now();
    state.flags[registry] = active;
    state.expiresAt[registry] = active && expires ?
      expires.toDate().toISOString() : null;
  }
  return state;
}

/**
 * Reads both flags, expiry already applied.
 *
 * @return {Promise<Force503Flags>} Current flags.
 */
export async function readForce503Flags(): Promise<Force503Flags> {
  return (await readForce503State()).flags;
}

/**
 * Whether the next request to one registry must be answered with 503.
 *
 * @param {RegistryId} registry Registry about to be called.
 * @return {Promise<boolean>} True to synthesise a 503. Always false outside
 *   the emulator, without touching Firestore.
 */
export async function isForced503(registry: RegistryId): Promise<boolean> {
  if (!isEmulator()) return false;
  return (await readForce503Flags())[registry];
}

/**
 * Sets one registry's flag. Switching on stamps the expiry that makes the
 * flag die on its own. Caller (the dev callable) is responsible for the
 * emulator gate; this helper only persists.
 *
 * @param {RegistryId} registry Registry to force.
 * @param {boolean} enabled True to answer 503, false to behave normally.
 * @return {Promise<void>} Resolves once written.
 */
export async function setForced503(
  registry: RegistryId,
  enabled: boolean,
): Promise<void> {
  await flagRef().set({
    [registry]: enabled,
    [`${registry}ExpiresAt`]: enabled ?
      Timestamp.fromMillis(Date.now() + FORCE_503_TTL_MS) : null,
  }, {merge: true});
}
