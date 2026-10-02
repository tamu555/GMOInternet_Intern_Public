/**
 * `restoreDomain` — the "復旧" arrow of FIG.4.
 *
 * Only works inside the grace period, and only for the sponsoring registrar.
 * Both of those come back from the registry as distinct failures, so the
 * caller can tell "too late" apart from "not yours".
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {restoreOwnedDomain} from "../domain/domainLifecycle";
import {normaliseDomainName} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Restores one of the caller's `pendingDelete` domains. */
export const restoreDomain = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    try {
      const domainName = normaliseDomainName(
        String((request.data ?? {}).domainName ?? ""),
      );
      return await restoreOwnedDomain(request.auth.uid, domainName);
    } catch (error) {
      throw toHttpsError(error, "restoreDomain");
    }
  },
);
