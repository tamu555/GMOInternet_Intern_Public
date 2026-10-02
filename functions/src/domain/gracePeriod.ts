/**
 * How long a deleted domain stays restorable, per registry.
 *
 * FIG.4's redemption window is only useful to a member if the screen can say
 * how much of it is left ("あと◯日は戻せます", spec 3.5). `domain:info` reports
 * *that* the domain is in `redemptionPeriod` but never *until when*, so the
 * deadline is either the one `domain:delete` hands back in
 * `extension.pendingDeleteUntil` or, when there is none, the moment we issued
 * the delete plus the per-registry constant below.
 *
 * That constant lives here, once, for two reasons: it is a registry fact
 * rather than a display preference, and a copy of it in the frontend would
 * quietly rot the day either registry changes it.
 */
import type {RegistryId} from "../config/options";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grace-period length in days, keyed by registry.
 *
 * ✅ Both registries now document the same number, so this is no longer an
 * assumption: `DELETE /domains/{name}` and the `redemptionPeriod` row of the
 * status table state that a deleted domain stays restorable for
 * `grace-period-days` (**45 days**), after which a per-minute batch drops
 * `redemptionPeriod` and the name is purged `pending-delete-days` (5 days)
 * later (docs/registry-kitaqsign-v1-openapi.json,
 * docs/registry-kitaqnic-v1-openapi.json).
 *
 * The window is still keyed per registry rather than collapsed to one
 * constant: it is a registry policy, and one of the two changing it must not
 * silently change the other.
 */
export const RESTORE_GRACE_PERIOD_DAYS: Record<RegistryId, number> = {
  kitaqnic: 45,
  kitaqsign: 45,
};

/**
 * How long `autoRenewPeriod` (RFC 3915) stays on after an auto-renew, keyed
 * by registry: both document 「自動更新の直後から **45 日間**」 (§3.6 of each
 * Swagger). Within this window the renewal can still be undone, which is what
 * the 「取り消すなら残り◯日」 hint counts down to. Kept per registry for the
 * same reason as `RESTORE_GRACE_PERIOD_DAYS`.
 */
export const AUTO_RENEW_GRACE_PERIOD_DAYS: Record<RegistryId, number> = {
  kitaqnic: 45,
  kitaqsign: 45,
};

/**
 * The moment after which a delete can no longer be undone.
 *
 * @param {RegistryId} registry Registry holding the domain.
 * @param {Date} deletedAt When the delete was issued.
 * @return {string} ISO 8601 deadline.
 */
export function restorableUntilOf(
  registry: RegistryId,
  deletedAt: Date,
): string {
  const days = RESTORE_GRACE_PERIOD_DAYS[registry];
  return new Date(deletedAt.getTime() + days * DAY_MS).toISOString();
}

/**
 * The moment after which an auto-renew can no longer be cancelled.
 *
 * Neither registry reports the deadline itself — `domain:info` only says
 * *that* `autoRenewPeriod` is on — so it is derived: the renewal happened at
 * the previous expiry (`exDate` − 1 year, the auto-renew extends by exactly
 * one year), and the window lasts the grace period from that moment.
 *
 * @param {RegistryId} registry Registry holding the domain.
 * @param {Date} exDate Current expiry, i.e. the already-extended one.
 * @return {string} ISO 8601 deadline.
 */
export function autoRenewCancelableUntilOf(
  registry: RegistryId,
  exDate: Date,
): string {
  const renewedAt = new Date(exDate.getTime());
  renewedAt.setUTCFullYear(renewedAt.getUTCFullYear() - 1);
  const days = AUTO_RENEW_GRACE_PERIOD_DAYS[registry];
  return new Date(renewedAt.getTime() + days * DAY_MS).toISOString();
}
