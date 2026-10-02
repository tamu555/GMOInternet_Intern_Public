/**
 * `devSetDomainExpiry` — the dev panel's lever for manually verifying the
 * auto-renew-OFF expiry sweep (`domain/expirySweep.ts`, `jobs/expiryWorker.ts`,
 * spec 6.4 / TBD #15).
 *
 * Waiting for a real domain to reach its `exDate` is not a practical way to
 * exercise the sweep by hand, so this callable rewrites a caller-owned
 * domain's mirrored `exDate` straight to "already past" (one minute ago, by
 * default) — the exact condition `sweepAutoRenewOff` selects on once the
 * member also flips `autoRenew` off from the real UI. `autoRenew` itself is
 * deliberately left untouched here: toggling it is the very action under
 * test, not something this button should shortcut.
 *
 * Emulator-only by hard refusal, same as `devForceRegistry503` /
 * `devRegistryMaintenance`: outside the emulator the callable exists but
 * answers `failed-precondition`, so a mistaken deploy can never rewrite a
 * real member's expiry. UNLIKE those two callables this one requires
 * authentication, because it mutates one member's own Firestore mirror
 * rather than a shared, registry-wide flag.
 *
 * Only the Firestore mirror is touched — the registry's own `exDate` is left
 * exactly as `domain:create` set it. That is fine for this feature's purpose:
 * both the expiry sweep and the MyPage domain list read the mirror, never the
 * registry's `exDate` directly.
 *
 * ⚠️ The mirror's `exDate` has one more reader: `renewOrder` snapshots it as
 * the order's `curExpDate`, so after this lever the snapshot no longer
 * matches the registry's real expiry. That is safe — the registries renew
 * from their own stored expiry, ignoring `curExpDate`, and `renewDomain`
 * trusts the registry's success answer (committing the observed `exDate`
 * even when it differs from the snapshot-derived expectation) — but expect
 * a renewal issued after this lever to log a snapshot-mismatch warn and to
 * land on a term computed from the registry's REAL expiry, not the fake one
 * written here.
 */
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {db} from "../config/firebase";
import {assertOwnsDomain} from "../domain/ownership";
import {normaliseDomainName, ValidationError} from "../domain/validation";
import {isEmulator} from "../dev/force503Flag";
import {toHttpsError} from "./httpsErrors";

/** Request wire shape. */
interface DevSetDomainExpiryRequest {
  domainName?: string;
  exDate?: string;
}

/** Response returned to the client. */
interface DevSetDomainExpiryResponse {
  domainName: string;
  exDate: string;
}

/**
 * Validates an optional caller-supplied target `exDate`, rejecting anything
 * that does not parse as a real timestamp. Defaulting (when `raw` is
 * undefined) is left to the caller so the "one minute ago" default stays a
 * single source of truth in the handler below.
 *
 * @param {string | undefined} raw Candidate ISO timestamp from the client.
 * @return {string} `raw` unchanged, once confirmed to parse.
 */
function validateExDate(raw: string): string {
  if (Number.isNaN(new Date(raw).getTime())) {
    throw new ValidationError("exDate", "exDate が日付として解釈できません。");
  }
  return raw;
}

/**
 * Rewrites the caller-owned domain's mirrored `exDate` to a near-past value
 * (default) or to the caller-supplied `exDate`, so the domain is immediately
 * eligible for `sweepAutoRenewOff` once `autoRenew` is also off.
 */
export const devSetDomainExpiry = onCall(async (request) => {
  if (!isEmulator()) {
    throw new HttpsError(
      "failed-precondition",
      "この操作はローカルエミュレータでのみ使用できます。",
    );
  }
  const uid = await requireActiveUser(request.auth);

  try {
    const data = (request.data ?? {}) as DevSetDomainExpiryRequest;

    if (typeof data.domainName !== "string") {
      throw new ValidationError(
        "domainName",
        "ドメイン名は文字列で指定してください。",
      );
    }
    const domainName = normaliseDomainName(data.domainName);

    const exDate = data.exDate !== undefined ?
      validateExDate(data.exDate) :
      new Date(Date.now() - 60_000).toISOString();

    const firestore = db();
    const owned = await assertOwnsDomain(uid, domainName, firestore);
    await owned.ref.set({exDate}, {merge: true});

    return {domainName, exDate} satisfies DevSetDomainExpiryResponse;
  } catch (error) {
    throw toHttpsError(error, "devSetDomainExpiry");
  }
});
