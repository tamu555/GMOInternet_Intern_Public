/**
 * `runExpirySweep` — runs the auto-renew-OFF expiry batch on demand.
 *
 * Scheduled functions do not fire in the emulator, and a five-minute wait is
 * not something to do in front of an audience, so the same work is reachable
 * as a Callable for local development and for the demo — the same shape as
 * `drainPollQueue` for the poll worker.
 *
 * Emulator-only, like the `dev*` Callables: the sweep deletes every member's
 * eligible domains and `now` lets the caller move the clock, so it is an
 * operator action no member may trigger on a deployed project. In production
 * the scheduled `expiryWorker` is the only path that runs this work.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {isEmulator} from "../dev/force503Flag";
import {sweepAutoRenewOff} from "../domain/expirySweep";
import {toHttpsError} from "./httpsErrors";

/** Runs one expiry-sweep pass. */
export const runExpirySweep = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 300},
  async (request) => {
    if (!isEmulator()) {
      throw new HttpsError(
        "failed-precondition",
        "この操作はローカルエミュレータでのみ使用できます。",
      );
    }
    await requireActiveUser(request.auth);
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    try {
      // `now` is dev/demo-only: it lets a test or a live demo pretend the
      // clock has moved past a domain's `exDate` without actually waiting.
      // Rejected outright when malformed, rather than silently falling back
      // to the real clock, so a typo cannot be mistaken for "ran with now".
      const asked = (request.data ?? {}).now as string | undefined;
      let now: Date | undefined;
      if (asked !== undefined) {
        const parsed = new Date(asked);
        if (Number.isNaN(parsed.getTime())) {
          throw new HttpsError(
            "invalid-argument",
            "now は ISO 8601 形式の日時文字列で指定してください。",
          );
        }
        now = parsed;
      }
      return await sweepAutoRenewOff({now});
    } catch (error) {
      throw toHttpsError(error, "runExpirySweep");
    }
  },
);
