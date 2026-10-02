/**
 * Scheduled poll worker (FIG.3).
 *
 * One Cloud Scheduler job drains both registries rather than one job each.
 * Spec 3.7 asks for a worker per registry, and that is what
 * `drainRegistryQueue` is — the registries are still drained independently,
 * with a failure in one unable to stop the other. What is shared is the
 * trigger, because the Cloud Scheduler free tier allows three jobs a month
 * and the expiry BATCH (spec 6.4) needs one of them.
 *
 * Splitting this into two `onSchedule` functions is a few lines if the team
 * would rather spend the second job here.
 */
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {REGISTRY_SECRETS} from "../config/options";
import {drainAllQueues} from "../domain/pollWorker";
import {
  registerMaintenancePollHandlers,
} from "../domain/maintenanceNotifications";
import {reconcilePendingTransfers} from "../domain/transferReconciler";
import {purgeAgedLogs} from "../domain/logRetention";
import {registerTransferPollHandlers} from "../domain/transferNotifications";
import {runWatchSweep} from "../domain/watches";

// At module load, so a drain can never run with the transfer handler missing
// (spec 6.6: the 20-minute auto-approve means a transfer can complete with
// nobody having clicked anything, and this is the only way we hear about it).
registerTransferPollHandlers();
// Likewise for maintenance announcements: missing one means the next window
// looks like an unexplained outage (registryMaintenance.ts).
registerMaintenancePollHandlers();

/**
 * Drains both registry queues every two minutes.
 *
 * ⚠️ The emulator does not fire scheduled functions. Use the
 * `drainPollQueue` Callable to run the same work by hand while developing.
 */
export const pollWorker = onSchedule(
  {
    // 申請が来てないかチェックの時間間隔
    schedule: "every 5 minutes",
    secrets: REGISTRY_SECRETS,
    timeoutSeconds: 300,
    // A second copy would poll the same queue and fight over the acks.
    maxInstances: 1,
  },
  async () => {
    const results = await drainAllQueues();
    for (const result of results) {
      logger.info("poll run finished", {...result});
    }
    // Poll first, then reconcile: a notification that did arrive settles its
    // transfer the precise way; the reconciler then covers the ones the
    // registry never sends (auto-approve to the losing side, silent purges).
    const reconciled = await reconcilePendingTransfers();
    logger.info("transfer reconcile finished", {...reconciled});
    // 空き待ちの再チェック (domain/watches.ts). `force` because this schedule
    // IS the cadence — the sweep's own floor only exists for the manual
    // drain path. A sweep failure must not block log retention below.
    await runWatchSweep({force: true}).catch((error) =>
      logger.error("watch sweep failed", {error: String(error)}));
    // Last, so a retention failure can never block polling or reconciling.
    await purgeAgedLogs();
  },
);
