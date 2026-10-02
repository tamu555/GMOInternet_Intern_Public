/**
 * `devRegistryMaintenance` — the dev panel's lever for announced-maintenance
 * verification (docs/仕様/registry-unavailable.md §3.5 / §7).
 *
 * Instead of switching a mode on the external mock API (whose state nobody
 * can see from here), this writes a maintenance window into the SAME record
 * a real poll announcement would produce (registryMaintenance.ts), so the
 * gate, searchDomains and the 🔧 UI behave exactly as in a real announced
 * window. The window always carries an end time, which is what makes the
 * switch leftover-proof: a forgotten window releases itself when the end
 * passes — even across emulator restarts and branch switches, where a plain
 * boolean flag used to linger (the devForce503 incident of 2026-08-27).
 *
 * Emulator-only by hard refusal, not by hiding, same as
 * devForceRegistry503: outside the emulator the callable answers
 * `failed-precondition`. Deliberately unauthenticated — the search screen it
 * demonstrates against is public.
 */
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {REGISTRY_IDS, type RegistryId} from "../config/options";
import {isEmulator} from "../dev/force503Flag";
import {
  clearMaintenance,
  maintenanceSummary,
  setMaintenance,
  type MaintenanceSummary,
} from "../bridge/registryMaintenance";

/** Longest window the panel may open, in minutes. */
export const MAX_DEV_MAINTENANCE_MINUTES = 180;

/** Request wire shape. */
interface DevMaintenanceRequest {
  action?: "get" | "set" | "clear";
  registry?: string;
  durationMinutes?: number;
}

/**
 * Reads, opens or clears a verification maintenance window per registry.
 *
 * `{action:'get'}` → `{maintenance}`; `{action:'set', registry,
 * durationMinutes}` opens a window from now for that many minutes;
 * `{action:'clear', registry}` retires it early. Every answer carries the
 * state after the mutation, read side-effect-free (maintenanceSummary — the
 * gate would consume the probe slot of an unbounded window).
 */
export const devRegistryMaintenance = onCall(async (request) => {
  if (!isEmulator()) {
    throw new HttpsError(
      "failed-precondition",
      "この操作はローカルエミュレータでのみ使用できます。",
    );
  }

  const data = (request.data ?? {}) as DevMaintenanceRequest;

  if (data.action === "set" || data.action === "clear") {
    const registry = data.registry as RegistryId;
    if (!REGISTRY_IDS.includes(registry)) {
      throw new HttpsError("invalid-argument", "registry が不正です。");
    }
    if (data.action === "set") {
      const minutes = data.durationMinutes;
      if (typeof minutes !== "number" || !Number.isFinite(minutes) ||
          minutes < 1 || minutes > MAX_DEV_MAINTENANCE_MINUTES) {
        throw new HttpsError("invalid-argument",
          `durationMinutes は 1〜${MAX_DEV_MAINTENANCE_MINUTES} の数値です。`);
      }
      const now = Date.now();
      await setMaintenance(registry, {
        windowStart: new Date(now),
        windowEnd: new Date(now + minutes * 60_000),
        msgId: null,
        msgType: "dev:maintenance",
        note: "モックAPI設定パネルからの検証用メンテナンス窓",
        rawPayload: null,
      });
    } else {
      await clearMaintenance(registry, "notification");
    }
  } else if (data.action !== "get") {
    throw new HttpsError("invalid-argument",
      "action は get / set / clear です。");
  }

  const summaries = await Promise.all(
    REGISTRY_IDS.map((registry) => maintenanceSummary(registry)));
  const maintenance = {} as Record<RegistryId, MaintenanceSummary>;
  REGISTRY_IDS.forEach((registry, index) => {
    maintenance[registry] = summaries[index] as MaintenanceSummary;
  });
  return {maintenance};
});
