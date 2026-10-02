/**
 * `deleteDomain` — the "今すぐ削除" branch of FIG.4.
 *
 * The screen is required to spell out the consequences before it gets here
 * (spec 6.5: "Webサイトとメールが止まります"). This function's job is the
 * part the UI cannot be trusted with: proving the caller owns the domain, and
 * reporting back what the registry actually did rather than what we assume.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {deleteOwnedDomain} from "../domain/domainLifecycle";
import {normaliseDomainName} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Deletes one of the caller's domains, moving it to `pendingDelete`. */
export const deleteDomain = onCall(
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
      return await deleteOwnedDomain(request.auth.uid, domainName);
    } catch (error) {
      throw toHttpsError(error, "deleteDomain");
    }
  },
);
