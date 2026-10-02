/**
 * `domain:rotate authInfo` — 移管用の認証コード（AuthCode）の再生成 (spec 3.9).
 *
 * The AuthCode is the transfer protocol's proof of control: whoever holds it
 * can ask another registrar to take the domain (spec 6.6). Re-minting it is
 * therefore two features at once — the first step of a deliberate move out,
 * and the emergency stop for a code that leaked — and both need the same
 * guarantee, which the registries give: 「新 raw を 1 度だけ返し、旧 authInfo
 * は即無効化される」.
 *
 * Three rules follow from that, and they are the whole module.
 *
 * **The new value is never stored.** It travels registry → this function →
 * the member's screen and stops there. `getDomainInfo` never returns an
 * authInfo, the list projection excludes it, and nothing here puts it back
 * into Firestore. What the mirror does get is the *removal* of the stale
 * `authInfo` the create flow recorded — that value stopped opening anything
 * the moment the registry answered, so leaving it in the database would be
 * keeping a secret that is all risk and no use — plus the moment of the
 * rotation, for the audit trail.
 *
 * **The command is never retried.** A re-send would mint a *second* secret
 * and kill the one the member is holding, and no command reads an authInfo
 * back, so a lost answer cannot be recovered by asking (see
 * `BaseRegistryClient.rotateAuthInfo`).
 *
 * **Ownership is proved before the registry is touched** (spec 7.3), through
 * the same `assertOwnsDomain` gate the other mutating commands use: a member
 * must never be able to mint a transfer key for somebody else's domain, and
 * "not yours" must be indistinguishable from "no such domain".
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryId} from "../config/options";
import {domainClTrid} from "./clTrid";
import {syncDomainRecord} from "./domainRecords";
import {assertOwnsDomain} from "./ownership";

/** What one rotation produced, shaped for the Callable. */
export interface AuthInfoRotationResult {
  domainName: string;
  registry: RegistryId;
  /**
   * The new AuthCode. This is the only copy: it is not stored, not logged,
   * and cannot be read back — a member who loses it rotates again.
   */
  authInfo: string;
  /** ISO 8601 moment the registry accepted the rotation. */
  rotatedAt: string;
  /** Message intended for the UI, already in Japanese. */
  message: string;
}

/**
 * Re-mints the AuthCode of one of the caller's domains.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain to rotate, already normalised.
 * @return {Promise<AuthInfoRotationResult>} The new code, once.
 */
export async function rotateDomainAuthInfo(
  uid: string,
  domainName: string,
): Promise<AuthInfoRotationResult> {
  const owned = await assertOwnsDomain(uid, domainName);
  const client = getRegistryClient(owned.registry);

  // No operation reservation and no lease, unlike `updateDomain` and the
  // transfer commands. Those lock because a half-applied command leaves
  // Firestore state that has to be reconciled against the registry; rotation
  // writes nothing worth reconciling, and the registry itself serialises two
  // concurrent calls — the second simply wins, and each caller is told
  // exactly which value it minted. The `syncState` gate inside
  // `assertOwnsDomain` still keeps a rotation out of a mutation already in
  // flight.
  const rotation = await client.rotateAuthInfo(
    domainName,
    domainClTrid("ROTATE", domainName, Date.now().toString(36)),
    {uid},
  );
  const rotatedAt = new Date().toISOString();

  try {
    await syncDomainRecord(uid, domainName, undefined, {
      // Not `rotation.authInfo`: the new code is deliberately not stored (see
      // module doc). Null clears the create flow's copy, which the registry
      // has just invalidated.
      authInfo: null,
      authInfoRotatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    // The registry has already replaced the passphrase and the answer in hand
    // is the only copy of the new one. Failing the call over a bookkeeping
    // write would throw that copy away and leave the member with no working
    // code at all, so this is reported loudly and the rotation still returns.
    // The stale mirror value is harmless to the member — nothing reads it —
    // and the next successful write clears it.
    logger.error("authInfo rotated but the mirror could not be updated", {
      uid,
      domainName,
      registry: owned.registry,
      error: String(error),
    });
  }

  return {
    domainName,
    registry: owned.registry,
    authInfo: rotation.authInfo,
    rotatedAt,
    message:
      "認証コード（AuthCode）を再生成しました。以前のコードは使えません。",
  };
}
