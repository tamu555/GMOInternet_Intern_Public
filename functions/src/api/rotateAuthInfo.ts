/**
 * `rotateAuthInfo` — 移管用の認証コードの再生成 (spec 3.9, FIG.10).
 *
 * Thin like every other Callable here: authenticate, normalise the name, hand
 * over to the use case, translate whatever comes back.
 *
 * Its answer is the one place in this service where an authInfo travels to a
 * client, and it does so exactly once (`domain/rotateAuthInfo.ts`), which is
 * why `getDomainInfo` can go on never returning one: the member's copy comes
 * from here or from a fresh rotation, never from a stored value.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {rotateDomainAuthInfo} from "../domain/rotateAuthInfo";
import {normaliseDomainName} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Re-mints the AuthCode of one of the caller's domains. */
export const rotateAuthInfo = onCall(
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
      return await rotateDomainAuthInfo(request.auth.uid, domainName);
    } catch (error) {
      // The thrown value never carries the passphrase: the use case only ever
      // returns it, and the BRIDGE layer's errors quote the command and the
      // transaction ids, not the body.
      throw toHttpsError(error, "rotateAuthInfo");
    }
  },
);
