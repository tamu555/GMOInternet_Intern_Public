/**
 * `devForceRegistry503` — the dev panel's lever for the 503 fault injection
 * (docs/仕様/registry-unavailable.md; the 故障注入スイッチ of spec §10.2).
 *
 * Emulator-only by hard refusal, not by hiding: outside the emulator the
 * callable exists but answers `failed-precondition`, so a mistaken deploy
 * can never become a production kill switch. Deliberately unauthenticated —
 * the search screen it demonstrates against is public, and the flags are
 * powerless outside the emulator anyway.
 */
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {REGISTRY_IDS, type RegistryId} from "../config/options";
import {healthState} from "../bridge/registryHealth";
import {
  isEmulator,
  readForce503State,
  setForced503,
} from "../dev/force503Flag";

/** Request wire shape. */
interface DevForce503Request {
  action?: "get" | "set";
  registry?: string;
  enabled?: boolean;
}

/**
 * Reads or writes the per-registry force-503 flags.
 *
 * `{action:'get'}` → `{flags, expiresAt, health}`; `{action:'set', registry,
 * enabled}` → the same answer after writing. `health` carries the circuit
 * state so the panel can show "接続不能と判定済み" next to each switch;
 * `expiresAt` says when each active flag switches itself off
 * (force503Flag.ts).
 */
export const devForceRegistry503 = onCall(async (request) => {
  if (!isEmulator()) {
    throw new HttpsError(
      "failed-precondition",
      "この操作はローカルエミュレータでのみ使用できます。",
    );
  }

  const data = (request.data ?? {}) as DevForce503Request;

  if (data.action === "set") {
    const registry = data.registry as RegistryId;
    if (!REGISTRY_IDS.includes(registry)) {
      throw new HttpsError("invalid-argument", "registry が不正です。");
    }
    if (typeof data.enabled !== "boolean") {
      throw new HttpsError("invalid-argument", "enabled が不正です。");
    }
    await setForced503(registry, data.enabled);
  } else if (data.action !== "get") {
    throw new HttpsError("invalid-argument", "action は get / set です。");
  }

  const [state, ...states] = await Promise.all([
    readForce503State(),
    ...REGISTRY_IDS.map((registry) => healthState(registry)),
  ]);
  const health: Record<string, "ok" | "unavailable"> = {};
  REGISTRY_IDS.forEach((registry, index) => {
    health[registry] = states[index] as "ok" | "unavailable";
  });
  return {flags: state.flags, expiresAt: state.expiresAt, health};
});
