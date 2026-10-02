/**
 * Static configuration for the assistant feature (spec browser-ai.md §14.2).
 * This feature has no backend of its own (§14.1) - the model id, Route
 * Manifest, Playbooks and inference parameters all ship with the frontend
 * bundle and change only via a frontend redeploy (including the emergency
 * kill switch, `enabled: false`, ⚠️).
 */

// frontend/src/features/assistant/config/assistantConfig.ts
export const ASSISTANT_CONFIG = {
  enabled: true,
  assistantVersion: '1.0',
  model: {
    id: 'Qwen3-0.6B-q4f16_1-MLC',
    fallbackId: null as string | null, // required_features 付きモデル追加時に使用（§5.1）
    version: '1', // §18.2 のキャッシュ更新判定
    downloadBytes: 357_000_000, // 実測 335.2 MiB + WASM 5.3 MiB（§5.1）。容量判定と同意文言に使用。MODEL_PROVENANCE.md と同期
  },
  inference: { temperature: 0.1, topP: 0.9, maxTokens: 384, historyTurns: 10 },
  thresholds: { minConfidence: 0.5 }, // §11.6
  limits: { inputMaxChars: 500, generationTimeoutMs: 60_000 }, // §12.3, §16
} as const

/**
 * Local-machine dev override only (§6.1: "env only suppresses"). Follows the
 * same `VITE_*` string-flag convention as `config.ts`'s `shouldUseMocks()`,
 * but is a plain `=== 'true'` check on purpose - unlike `ASSISTANT_CONFIG.enabled`
 * (the service-wide kill switch), this can only ever turn the feature OFF,
 * never on, and has no DEV fallback.
 */
export function assistantDisabledByEnv(): boolean {
  return import.meta.env.VITE_ASSISTANT_DISABLED === 'true'
}

export function assistantEnabled(): boolean {
  return ASSISTANT_CONFIG.enabled && !assistantDisabledByEnv()
}

/** §7.6: sessionStorage key for the ChatSessionStore. */
export const ASSISTANT_CHAT_STORAGE_KEY = 'registrar.assistant.chat'
/** §18.2: localStorage key recording which model version is cached on this device. */
export const ASSISTANT_MODEL_VERSION_STORAGE_KEY = 'registrar.assistant.modelVersion'
/** §17.2: localStorage key recording the user's consent to download on a slow connection. */
export const ASSISTANT_DOWNLOAD_CONSENT_STORAGE_KEY = 'registrar.assistant.downloadConsent'
/** §6.5: localStorage key for the simple cross-tab first-download exclusion lock. */
export const ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY = 'registrar.assistant.downloadLock'

/** §6.5: required free storage must be at least this factor times downloadBytes. */
export const STORAGE_QUOTA_SAFETY_FACTOR = 1.5
/** §6.5: a download lock older than this is considered stale/abandoned. */
export const DOWNLOAD_LOCK_TTL_MS = 5 * 60 * 1000
