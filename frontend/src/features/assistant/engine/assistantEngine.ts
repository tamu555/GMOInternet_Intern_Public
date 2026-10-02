/**
 * WebLLM execution engine (spec browser-ai.md §6.1, §6.5, §15.2, §15.3,
 * §15.4, §16). This is the real `AssistantEngine` implementation; jsdom
 * tests inject `fakeAssistantEngine.ts` instead (§14.3, §15.2).
 *
 * FR-17: the only network traffic this module (transitively, via WebLLM) can
 * cause is fetching the model weights/tokenizer from huggingface.co and the
 * WASM model library from raw.githubusercontent.com (§18.1). This module
 * never calls a Callable and never sends telemetry.
 */
import type { AppConfig, WebWorkerMLCEngine } from '@mlc-ai/web-llm'
import { ASSISTANT_CONFIG } from '../config/assistantConfig'
import { generationOptions } from '../prompt/promptBuilder'
import type { AssistantChatRequest, AssistantEngine } from '../types'

/**
 * §17.1: the WebLLM library must never be part of the initial page bundle -
 * loading it eagerly would put ~6 MB of JS in front of first paint and in
 * front of the search Callable, which is exactly the priority inversion
 * §17.2 forbids ("ドメイン検索 ★★★★★ / AI ★★★☆☆"). Every main-thread use
 * therefore goes through this dynamic `import()`, so Vite emits WebLLM as a
 * separate async chunk that is fetched only once `scheduleAssistantModelLoad()`
 * runs in idle time (§6.1). The type-only imports above are erased at compile
 * time and cost nothing at runtime.
 *
 * The worker (`assistantWorker.ts`) keeps its static import on purpose: it is
 * its own bundle entry and is only ever instantiated from `load()`.
 */
function loadWebLlm(): Promise<typeof import('@mlc-ai/web-llm')> {
  return import('@mlc-ai/web-llm')
}

/** §6.5 verbatim: IndexedDB is the persistent cache backend for the model. */
export async function createAssistantAppConfig(): Promise<AppConfig> {
  const { prebuiltAppConfig } = await loadWebLlm()
  return { ...prebuiltAppConfig, cacheBackend: 'indexeddb' }
}

/**
 * `createWebLlmEngine()`'s return type. `crashRecoveryCount` is not part of
 * the shared `AssistantEngine` contract (other waves code against that
 * narrower interface) - it exists purely so this module's own tests can
 * assert the §16 "exactly once per load session" crash-recovery behavior
 * without reaching into closures.
 */
export interface WebLlmAssistantEngine extends AssistantEngine {
  readonly crashRecoveryCount: number
}

type ProgressCallback = (report: { progress: number; timeElapsed: number; text: string }) => void

/**
 * Real WebLLM implementation of `AssistantEngine`.
 *
 * Design decisions (see the wave report for the full rationale):
 * - `chat()`'s abort/timeout contract: calling `engine.interruptGenerate()`
 *   does NOT throw inside WebLLM (verified against `@mlc-ai/web-llm`'s
 *   bundled source: `interruptSignal` only breaks the internal decode loop,
 *   the async generator then ends normally). So `chat()` never rejects on
 *   abort or on the internal §16 60s timeout - it resolves with whatever
 *   text had already streamed through `onDelta` before the interrupt. The
 *   caller (chat orchestration / modelStore) is responsible for reading
 *   `signal?.aborted` to decide whether to mark the resulting message
 *   `'failed'` (§15.6 abort-on-conversation-switch, §16 timeout) or `'done'`.
 * - Crash recovery (§16): a `Worker` `error`/`messageerror` event, or an
 *   exception thrown out of `chat.completions.create()`/the chunk stream,
 *   triggers exactly one recovery attempt per `load()` session (terminate +
 *   recreate the worker + `CreateWebWorkerMLCEngine` again, which reloads
 *   the model from the IndexedDB cache rather than re-downloading it). A
 *   second failure after that leaves the engine unloaded; the next `chat()`/
 *   `abort()` call throws, and the caller (modelStore) surfaces `ERROR`.
 *   The two crash sources are deduped through a single in-flight recovery
 *   promise so a worker-level error firing during a `chat()` catch block
 *   never double-counts as two failures.
 */
export function createWebLlmEngine(): WebLlmAssistantEngine {
  let worker: Worker | null = null
  let engine: WebWorkerMLCEngine | null = null
  let loadPromise: Promise<void> | null = null
  let recoveryPromise: Promise<void> | null = null
  let lastProgressCallback: ProgressCallback | null = null
  let crashRecoveryCount = 0

  function handleWorkerCrash(): void {
    // Fire-and-forget: nothing is awaiting this specific event. If recovery
    // fails, `engine` is left `null` and the next `chat()`/`abort()` call
    // surfaces that to its caller.
    void scheduleRecovery()
  }

  function createWorker(): Worker {
    const nextWorker = new Worker(new URL('./assistantWorker.ts', import.meta.url), { type: 'module' })
    nextWorker.addEventListener('error', handleWorkerCrash)
    nextWorker.addEventListener('messageerror', handleWorkerCrash)
    return nextWorker
  }

  async function performRecovery(): Promise<void> {
    if (crashRecoveryCount >= 1) {
      // §16: "再失敗で ERROR" - the second failure is not retried again.
      worker?.terminate()
      worker = null
      engine = null
      throw new Error('AssistantEngine crashed again after one recovery attempt')
    }
    crashRecoveryCount += 1
    worker?.terminate()
    worker = createWorker()
    const { CreateWebWorkerMLCEngine } = await loadWebLlm()
    engine = await CreateWebWorkerMLCEngine(worker, ASSISTANT_CONFIG.model.id, {
      appConfig: await createAssistantAppConfig(),
      initProgressCallback: lastProgressCallback ?? undefined,
    })
  }

  function scheduleRecovery(): Promise<void> {
    if (!recoveryPromise) {
      recoveryPromise = performRecovery().finally(() => {
        recoveryPromise = null
      })
    }
    return recoveryPromise
  }

  async function load(onProgress: ProgressCallback): Promise<void> {
    if (engine) return // §6.1: idempotent while already loaded.
    if (loadPromise) return loadPromise
    lastProgressCallback = onProgress
    crashRecoveryCount = 0
    loadPromise = (async () => {
      const { CreateWebWorkerMLCEngine } = await loadWebLlm()
      worker = createWorker()
      engine = await CreateWebWorkerMLCEngine(worker, ASSISTANT_CONFIG.model.id, {
        appConfig: await createAssistantAppConfig(),
        initProgressCallback: onProgress,
      })
    })()
    try {
      await loadPromise
    } finally {
      loadPromise = null
    }
  }

  async function chat(request: AssistantChatRequest, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    if (!engine) throw new Error('AssistantEngine.chat() called before a successful load()')

    let settled = false
    const interrupt = () => {
      if (settled) return
      engine?.interruptGenerate()
    }
    signal?.addEventListener('abort', interrupt)
    // §16: 60s generation timeout, measured from the call, enforced here in
    // addition to whatever caller-side timeout exists.
    const timeoutId = setTimeout(interrupt, ASSISTANT_CONFIG.limits.generationTimeoutMs)

    let accumulated = ''
    try {
      const stream = await engine.chat.completions.create({ messages: request.messages, ...generationOptions() })
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (delta) {
          accumulated += delta
          onDelta(delta)
        }
      }
      return accumulated
    } catch (error) {
      // §16: an inference exception gets one silent recovery attempt so the
      // engine keeps working for the *next* chat() call; this request still
      // fails for its own caller.
      await scheduleRecovery().catch(() => {
        // performRecovery() already cleared worker/engine on double failure.
      })
      throw error
    } finally {
      settled = true
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', interrupt)
    }
  }

  function abort(): void {
    engine?.interruptGenerate()
  }

  async function unload(): Promise<void> {
    if (engine) {
      await engine.unload()
    }
    worker?.terminate()
    worker = null
    engine = null
  }

  return {
    load,
    chat,
    abort,
    unload,
    get crashRecoveryCount() {
      return crashRecoveryCount
    },
  }
}
