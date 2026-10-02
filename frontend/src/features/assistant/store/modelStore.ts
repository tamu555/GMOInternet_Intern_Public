/**
 * Model lifecycle store (spec browser-ai.md §6, §15.6, §16). The stateful
 * layer on top of `engine/modelStatus.ts`'s pure probes/state-machine and
 * `engine/assistantEngine.ts`'s `AssistantEngine`. Owns the single WebLLM
 * engine instance for this tab (§15.6: "1 ブラウザタブにつき WebLLM Engine
 * は原則1つ").
 *
 * Design decisions (see the wave report for the full rationale):
 * - `INITIALIZING` heuristic: WebLLM's `InitProgressReport` does not
 *   separate "downloading" from "initializing" - we treat a report with
 *   `progress >= 1` as the fetch phase having ended and surface
 *   `INITIALIZING` for it (visible briefly, potentially only for that final
 *   report) until `engine.load()` resolves and the store moves to `READY`.
 *   Every report with `progress < 1` stays `DOWNLOADING`.
 * - §20.1 event placement: `model_load_started`/`model_load_completed`/
 *   `model_load_failed` bracket only an actual *download attempt* (i.e. once
 *   `nextStatusAfterChecking()` has decided on `DOWNLOADING`), not the
 *   `CHECKING` phase itself. `UNSUPPORTED` and `AWAITING_CONSENT` therefore
 *   never fire `model_load_started` - a capability gate or a pending user
 *   decision is not a "load attempt" for §20.2's `model_load_completed /
 *   model_load_started` success-rate KPI. `insufficient_storage` (§16: no
 *   retry) likewise never reaches the download step, so it fires neither
 *   event either - only failures during the actual `engine.load()` call
 *   (`errorKind: 'load_failed'`) fire `model_load_failed`.
 * - No internal polling loop for `lockedByOtherTab`: when another tab holds
 *   the download lock, this store surfaces `{ status: 'CHECKING',
 *   lockedByOtherTab: true }` and stops - it does not retry itself on a
 *   timer. A caller (the UI wave) that wants to poll can call
 *   `startAssistantModelLoad()` again (e.g. on an interval or on next chat
 *   open); calling it while `runningPromise` is in flight is deduped.
 * - Once `status === 'READY'`, `startAssistantModelLoad()` is a no-op (the
 *   model is not reloaded on repeat calls - §15.6).
 */
import { assistantEnabled } from '../config/assistantConfig'
import { emitAssistantEvent } from '../events'
import {
  acquireDownloadLock,
  currentModelVersionKey,
  deleteStaleModel,
  detectWebGpu,
  estimateStorage,
  hasEnoughStorage,
  isDownloadLockedByOtherTab,
  isModelCached,
  isSlowConnection,
  modelIdFromVersionKey,
  needsCacheRefresh,
  nextStatusAfterChecking,
  readDownloadConsent,
  readModelVersionRecord,
  releaseDownloadLock,
  requestPersistentStorage,
  saveDownloadConsent,
  writeModelVersionRecord,
  type ModelErrorKind,
} from '../engine/modelStatus'
import { createWebLlmEngine } from '../engine/assistantEngine'
import type { AssistantEngine, ModelStatus } from '../types'

export interface ModelState {
  status: ModelStatus
  /** 0..1, from `InitProgressReport.progress`. */
  progress: number
  progressText: string
  errorKind: ModelErrorKind | null
  lockedByOtherTab: boolean
}

function initialModelState(): ModelState {
  return { status: 'NOT_STARTED', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false }
}

let state: ModelState = initialModelState()
let engine: AssistantEngine | null = null
let engineFactory: () => AssistantEngine = createWebLlmEngine
let runningPromise: Promise<void> | null = null
let tabId = crypto.randomUUID()

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function update(patch: Partial<ModelState>): void {
  state = { ...state, ...patch }
  notify()
}

/** Stable-reference snapshot, same requirement as `chatStore.ts`'s `getChatSnapshot()`. */
export function getModelSnapshot(): ModelState {
  return state
}

export function subscribeModelState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAssistantEngine(): AssistantEngine | null {
  return engine
}

/** Test seam: `null` restores the real `createWebLlmEngine` factory. */
export function setEngineFactoryForTest(factory: (() => AssistantEngine) | null): void {
  engineFactory = factory ?? createWebLlmEngine
}

export function resetModelStoreForTest(): void {
  state = initialModelState()
  engine = null
  engineFactory = createWebLlmEngine
  runningPromise = null
  tabId = crypto.randomUUID()
  listeners.clear()
}

/**
 * §18.2: reload -> READY confirmed -> delete the stale cached model -> record
 * the new version key. A failure here is swallowed (both cache functions
 * already never throw) - it must never turn a successful READY into ERROR.
 */
async function applyCacheRefreshIfNeeded(): Promise<void> {
  const recorded = readModelVersionRecord()
  if (needsCacheRefresh(recorded)) {
    await deleteStaleModel(modelIdFromVersionKey(recorded!))
  }
  writeModelVersionRecord(currentModelVersionKey())
}

async function beginDownload(cached: boolean): Promise<void> {
  const startedAt = Date.now()
  const lockAcquired = cached ? false : acquireDownloadLock(tabId, Date.now())

  if (!cached && !lockAcquired) {
    // TOCTOU: another tab grabbed the lock between CHECKING and here.
    update({ status: 'CHECKING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: true })
    return
  }

  update({ status: 'DOWNLOADING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
  emitAssistantEvent({ type: 'model_load_started' })

  try {
    if (!engine) engine = engineFactory()
    await engine.load((report) => {
      const status = report.progress >= 1 ? 'INITIALIZING' : 'DOWNLOADING'
      update({ status, progress: report.progress, progressText: report.text, errorKind: null, lockedByOtherTab: false })
    })

    update({ status: 'READY', progress: 1, progressText: '', errorKind: null, lockedByOtherTab: false })
    emitAssistantEvent({ type: 'model_load_completed', durationMs: Date.now() - startedAt })

    // §6.5: fire-and-forget, result not acted upon.
    void requestPersistentStorage()
    await applyCacheRefreshIfNeeded()
  } catch {
    update({ status: 'ERROR', progress: 0, progressText: '', errorKind: 'load_failed', lockedByOtherTab: false })
    emitAssistantEvent({ type: 'model_load_failed' })
  } finally {
    if (lockAcquired) releaseDownloadLock(tabId)
  }
}

async function runCheckingPhase(): Promise<void> {
  if (state.status === 'READY') return // §15.6: never reload once ready.

  update({ status: 'CHECKING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })

  if (!assistantEnabled()) {
    update({ status: 'UNSUPPORTED', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
    return
  }

  const [{ available: webGpuAvailable }, { quota, usage }] = await Promise.all([detectWebGpu(), estimateStorage()])
  const enoughStorage = hasEnoughStorage(quota, usage)
  const slowConnection = isSlowConnection()
  const consentGiven = readDownloadConsent()
  const cached = await isModelCached()
  const lockedByOtherTab = isDownloadLockedByOtherTab(tabId, Date.now())

  const decision = nextStatusAfterChecking({
    assistantEnabled: true,
    webGpuAvailable,
    enoughStorage,
    slowConnection,
    consentGiven,
    cached,
    lockedByOtherTab,
  })

  switch (decision.status) {
    case 'UNSUPPORTED':
      update({ status: 'UNSUPPORTED', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
      return
    case 'ERROR':
      // §16: insufficient_storage - no retry, and (by design, see module
      // doc) no model_load_* event: a download was never attempted.
      update({ status: 'ERROR', progress: 0, progressText: '', errorKind: decision.errorKind, lockedByOtherTab: false })
      return
    case 'AWAITING_CONSENT':
      update({ status: 'AWAITING_CONSENT', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
      return
    case 'CHECKING':
      // Uncached + another tab holds the download lock.
      update({ status: 'CHECKING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: true })
      return
    case 'DOWNLOADING':
      await beginDownload(cached)
      return
  }
}

/** Runs `NOT_STARTED/ERROR/... -> CHECKING -> ... -> READY`. Concurrent calls share the same in-flight run. */
export function startAssistantModelLoad(): Promise<void> {
  if (!runningPromise) {
    runningPromise = runCheckingPhase().finally(() => {
      runningPromise = null
    })
  }
  return runningPromise
}

/** §16: "再試行は CHECKING から". */
export function retryModelLoad(): Promise<void> {
  if (state.status !== 'READY') update({ status: 'CHECKING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
  return startAssistantModelLoad()
}

/** §17.2: persists consent, then resumes the same CHECKING -> ... flow (now past the consent gate). */
export function grantDownloadConsent(): Promise<void> {
  saveDownloadConsent()
  if (state.status !== 'READY') update({ status: 'CHECKING', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false })
  return startAssistantModelLoad()
}

function scheduleViaIdleCallback(run: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run)
    return
  }
  setTimeout(run, 0)
}

/**
 * §6.1/§17.2: kicks off the model load from idle time, without blocking
 * page render or higher-priority Callable traffic. A no-op when the
 * assistant is disabled (service-wide `enabled: false` or
 * `VITE_ASSISTANT_DISABLED`), and never throws into the app bootstrap that
 * calls it (`main.tsx`).
 */
export function scheduleAssistantModelLoad(): void {
  if (!assistantEnabled()) return
  try {
    scheduleViaIdleCallback(() => {
      void startAssistantModelLoad().catch(() => {
        // startAssistantModelLoad()/runCheckingPhase() route every failure
        // into `update({ status: 'ERROR' | 'UNSUPPORTED', ... })` rather than
        // rejecting - this catch is a defensive backstop only.
      })
    })
  } catch {
    // Never let a scheduling primitive break app bootstrap.
  }
}
