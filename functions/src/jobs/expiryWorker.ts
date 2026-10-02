/**
 * Scheduled expiry worker — the auto-renew-OFF batch (spec 6.4, TBD #15).
 *
 * `pollWorker.ts` reserves one of the Cloud Scheduler free tier's three jobs
 * for this batch; this is that job. It is a separate `onSchedule` rather than
 * folded into `pollWorker` because the two have nothing in common: one drains
 * registry notification queues, this one sweeps our own Firestore mirror for
 * domains whose member turned auto-renew off and whose term has ended
 * (`domain/expirySweep.ts` has the full reasoning for why that delete is
 * correct even though the registry already auto-renewed).
 */
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {REGISTRY_SECRETS} from "../config/options";
import {sweepAutoRenewOff} from "../domain/expirySweep";

/**
 * Sweeps auto-renew-OFF domains past their `exDate` once a day.
 *
 * Daily is enough: `exDate` only ever moves in whole days, and a domain the
 * registry auto-renewed before we got to it stays cancellable for the whole
 * 45-day `autoRenewPeriod` — being up to a day late costs nothing. Anything
 * more frequent only spends invocations against the free tier.
 *
 * ⚠️ The emulator does not fire scheduled functions. Use the
 * `runExpirySweep` Callable to run the same work by hand while developing.
 */
export const expiryWorker = onSchedule(
  {
    // Shortly after the date rolls over in JST, when new expiries appear.
    schedule: "every day 00:10",
    timeZone: "Asia/Tokyo",
    secrets: REGISTRY_SECRETS,
    timeoutSeconds: 300,
    // A second copy would race the same candidates and could issue duplicate
    // `domain:delete` calls for the same domain.
    maxInstances: 1,
  },
  async () => {
    // One run a day has to clear the whole day's expiries, so the cap is
    // per-day capacity here, not a per-tick nibble like the poll worker's.
    const result = await sweepAutoRenewOff({maxDomains: 200});
    logger.info("expiry sweep run finished", {...result});
  },
);
