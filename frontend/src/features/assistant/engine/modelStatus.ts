/**
 * Model lifecycle probes and the §6.3 state machine (spec browser-ai.md §6.2,
 * §6.3, §6.5, §17.2, §18.2). Pure functions and browser-API probes only - no
 * React, no mutable module state. `store/modelStore.ts` is the stateful
 * layer built on top of these.
 */
import {
  ASSISTANT_CONFIG,
  ASSISTANT_DOWNLOAD_CONSENT_STORAGE_KEY,
  ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY,
  ASSISTANT_MODEL_VERSION_STORAGE_KEY,
  DOWNLOAD_LOCK_TTL_MS,
  STORAGE_QUOTA_SAFETY_FACTOR,
} from '../config/assistantConfig'
import type { ModelStatus } from '../types'
import { createAssistantAppConfig } from './assistantEngine'

/* ------------------------------------------------------------------ */
/* WebGPU / storage / connection probes (§5.1, §6.5, §17.2)           */
/* ------------------------------------------------------------------ */

/**
 * §6.3/§5.1: WebGPU presence + `shader-f16` (unused by the v1 model, but
 * specified so a future `required_features` model can rely on it - §5.1).
 * Every property access is guarded: jsdom (and older real browsers) has no
 * `navigator.gpu` at all, so this must never throw.
 */
export async function detectWebGpu(): Promise<{ available: boolean; shaderF16: boolean }> {
  try {
    const gpu = typeof navigator === 'undefined' ? undefined : navigator.gpu
    if (!gpu || typeof gpu.requestAdapter !== 'function') return { available: false, shaderF16: false }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { available: false, shaderF16: false }
    return { available: true, shaderF16: adapter.features?.has('shader-f16') ?? false }
  } catch {
    return { available: false, shaderF16: false }
  }
}

/** §6.5: `navigator.storage.estimate()`, guarded - absent in some browsers/jsdom. */
export async function estimateStorage(): Promise<{ quota: number | null; usage: number | null }> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    const estimate = await storage?.estimate?.()
    return { quota: estimate?.quota ?? null, usage: estimate?.usage ?? null }
  } catch {
    return { quota: null, usage: null }
  }
}

/**
 * §6.5 verbatim threshold. When the Storage API is unavailable (`quota`/
 * `usage` both `null`), this deliberately returns `true` rather than
 * blocking: a browser that doesn't expose `navigator.storage.estimate()`
 * gives us no basis to refuse, and refusing by default would turn an
 * unrelated API gap into an unconditional §16 "capacity" error for every
 * such user.
 */
export function hasEnoughStorage(quota: number | null, usage: number | null): boolean {
  if (quota === null || usage === null) return true
  return quota - usage >= ASSISTANT_CONFIG.model.downloadBytes * STORAGE_QUOTA_SAFETY_FACTOR
}

/** §6.5: called once after READY. Return value is never acted upon; never throws. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
    return (await storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/**
 * `navigator.connection` (the Network Information API) is experimental and
 * not part of TypeScript's DOM lib, hence the local shape + cast.
 */
interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformationLike
}
const SLOW_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g'])

/** §17.2: absent `navigator.connection` (Safari/Firefox) means "assume fast" - auto-start per 要件1. */
export function isSlowConnection(): boolean {
  try {
    const connection = (navigator as NavigatorWithConnection).connection
    if (!connection) return false
    if (connection.saveData === true) return true
    return typeof connection.effectiveType === 'string' && SLOW_EFFECTIVE_TYPES.has(connection.effectiveType)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* localStorage-backed flags (§17.2 consent, §6.5 lock, §18.2 version) */
/* Follows auth/additionalInfoState.ts's try/catch template.          */
/* ------------------------------------------------------------------ */

/** §17.2: has the user already consented to a download on a slow connection? */
export function readDownloadConsent(): boolean {
  try {
    return window.localStorage.getItem(ASSISTANT_DOWNLOAD_CONSENT_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveDownloadConsent(): void {
  try {
    window.localStorage.setItem(ASSISTANT_DOWNLOAD_CONSENT_STORAGE_KEY, 'true')
  } catch {
    // Private mode / disabled storage: consent just won't be remembered next
    // visit - §17.2's fallback is asking again, not blocking the download.
  }
}

export interface DownloadLock {
  tabId: string
  startedAt: number
}

/**
 * 🔬 §6.5 caveat: WebLLM's own behavior under simultaneous multi-tab first
 * downloads (IndexedDB contention) is unverified upstream. This lock is
 * therefore only a best-effort, same-origin/localStorage-based exclusion,
 * not a guarantee against a real race.
 */
export function readDownloadLock(): DownloadLock | null {
  try {
    const raw = window.localStorage.getItem(ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DownloadLock>
    if (typeof parsed.tabId !== 'string' || typeof parsed.startedAt !== 'number') return null
    return { tabId: parsed.tabId, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

function isLockLive(lock: DownloadLock, now: number): boolean {
  return now - lock.startedAt < DOWNLOAD_LOCK_TTL_MS
}

/** §6.5: succeeds when there is no lock, an expired lock, or this tab already holds it. */
export function acquireDownloadLock(tabId: string, now: number): boolean {
  const current = readDownloadLock()
  if (current && current.tabId !== tabId && isLockLive(current, now)) return false
  try {
    window.localStorage.setItem(ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY, JSON.stringify({ tabId, startedAt: now }))
  } catch {
    // Storage unavailable: the cross-tab exclusion degrades silently (the
    // single-tab happy path is unaffected - see the 🔬 caveat above).
  }
  return true
}

/** Only clears the lock if this tab still owns it, so a stale release call never evicts a newer holder. */
export function releaseDownloadLock(tabId: string): void {
  try {
    const current = readDownloadLock()
    if (current && current.tabId === tabId) {
      window.localStorage.removeItem(ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY)
    }
  } catch {
    // Ignore.
  }
}

export function isDownloadLockedByOtherTab(tabId: string, now: number): boolean {
  const lock = readDownloadLock()
  if (!lock || lock.tabId === tabId) return false
  return isLockLive(lock, now)
}

/** §18.2: `${model.id}@${model.version}`, the value recorded once a model is confirmed READY. */
export function currentModelVersionKey(): string {
  return `${ASSISTANT_CONFIG.model.id}@${ASSISTANT_CONFIG.model.version}`
}

/**
 * Inverse of `currentModelVersionKey()`'s `${id}@${version}` format -
 * extracts just the `model.id` half, so `modelStore.ts`'s §18.2 refresh flow
 * can pass the OLD model id to `deleteStaleModel()` even though only the
 * composite key was ever persisted to `localStorage`.
 */
export function modelIdFromVersionKey(key: string): string {
  const atIndex = key.lastIndexOf('@')
  return atIndex === -1 ? key : key.slice(0, atIndex)
}

export function readModelVersionRecord(): string | null {
  try {
    return window.localStorage.getItem(ASSISTANT_MODEL_VERSION_STORAGE_KEY)
  } catch {
    return null
  }
}

export function writeModelVersionRecord(value: string): void {
  try {
    window.localStorage.setItem(ASSISTANT_MODEL_VERSION_STORAGE_KEY, value)
  } catch {
    // Ignore.
  }
}

/**
 * §18.2: a `null` record means "nothing cached yet on this device" - that is
 * a first download, not a refresh, so it does not need one.
 */
export function needsCacheRefresh(recorded: string | null): boolean {
  if (recorded === null) return false
  return recorded !== currentModelVersionKey()
}

/* ------------------------------------------------------------------ */
/* IndexedDB cache helpers (§6.5, §18.2)                              */
/* ------------------------------------------------------------------ */

export async function isModelCached(): Promise<boolean> {
  try {
    // §17.1: dynamic import, same reason as `assistantEngine.ts`'s
    // `loadWebLlm()` - WebLLM must stay out of the initial page bundle.
    const { hasModelInCache } = await import('@mlc-ai/web-llm')
    return await hasModelInCache(ASSISTANT_CONFIG.model.id, await createAssistantAppConfig())
  } catch {
    return false
  }
}

/** §18.2 best-effort cleanup of a superseded model version - never blocks READY on failure. */
export async function deleteStaleModel(modelId: string): Promise<void> {
  try {
    const { deleteModelAllInfoInCache } = await import('@mlc-ai/web-llm')
    await deleteModelAllInfoInCache(modelId, await createAssistantAppConfig())
  } catch {
    // Ignore - a leftover stale model only costs disk space, not correctness.
  }
}

/* ------------------------------------------------------------------ */
/* §6.3 state machine                                                 */
/* ------------------------------------------------------------------ */

export interface CapabilityReport {
  assistantEnabled: boolean
  webGpuAvailable: boolean
  enoughStorage: boolean
  slowConnection: boolean
  consentGiven: boolean
  cached: boolean
  lockedByOtherTab: boolean
}

export type ModelErrorKind = 'unsupported' | 'insufficient_storage' | 'load_failed' | 'timeout'

/**
 * §6.3 verbatim transition table, plus two extensions the table's prose
 * implies but doesn't draw as boxes:
 * - A cached model skips the slow-connection consent gate entirely (it is
 *   not a download - the wave instructions call this out explicitly).
 * - `lockedByOtherTab` (present in `CapabilityReport` for exactly this
 *   reason) keeps an *uncached* model out of `DOWNLOADING` and back at
 *   `CHECKING` instead, so `modelStore.ts` can poll until the other tab's
 *   lock clears rather than racing it into the same IndexedDB write.
 */
export function nextStatusAfterChecking(report: CapabilityReport): { status: ModelStatus; errorKind: ModelErrorKind | null } {
  if (!report.assistantEnabled || !report.webGpuAvailable) {
    return { status: 'UNSUPPORTED', errorKind: null }
  }
  if (!report.enoughStorage) {
    return { status: 'ERROR', errorKind: 'insufficient_storage' }
  }
  if (!report.cached) {
    if (report.slowConnection && !report.consentGiven) {
      return { status: 'AWAITING_CONSENT', errorKind: null }
    }
    if (report.lockedByOtherTab) {
      return { status: 'CHECKING', errorKind: null }
    }
  }
  return { status: 'DOWNLOADING', errorKind: null }
}
