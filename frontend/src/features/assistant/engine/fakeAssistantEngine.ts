/**
 * Fake `AssistantEngine` (spec browser-ai.md §14.3, §15.2). jsdom has no
 * WebGPU and no real module Worker support, so every UI/store test injects
 * this instead of `engine/assistantEngine.ts`. No WebGPU, no `Worker`, and no
 * timer longer than `delayMs` (0 by default) is ever used here.
 */
import type { AssistantChatRequest, AssistantEngine } from '../types'

export interface FakeEngineOptions {
  /** Streamed through `onDelta`/returned by `chat()`. Must stay a valid §11.3 wire payload (see `DEFAULT_FAKE_REPLY`) so callers exercise the real output parser. */
  reply?: string
  /** Number of characters delivered per `onDelta` call. */
  chunkSize?: number
  /** Number of synthetic `InitProgressReport`s `load()` emits before resolving. */
  loadSteps?: number
  /** `load()` rejects instead of resolving, after emitting `loadSteps` reports. */
  failLoad?: boolean
  /** `chat()` rejects immediately instead of streaming. */
  failChat?: boolean
  /** Delay between each streamed chunk / progress report, in ms. 0 still yields a microtask so `abort()`/`AbortSignal` can interrupt mid-stream. */
  delayMs?: number
}

/**
 * A minimal, valid §11.3 wire-format payload: 5 header lines, `---`, a
 * one-line body. English on purpose - user-facing copy belongs to
 * `assistantMessages.ts`, owned by another wave; this string is a test
 * fixture standing in for whatever the (simulated) model would have said.
 */
export const DEFAULT_FAKE_REPLY = [
  'intent: EXPLAIN_DNS',
  'route: none',
  'slots: ',
  'confidence: 0.9',
  'clarify: no',
  '---',
  'This is a fake assistant reply used in tests.',
].join('\n')

export interface FakeAssistantEngine extends AssistantEngine {
  calls: { load: number; chat: number; abort: number; unload: number }
  lastRequest: AssistantChatRequest | null
}

/** Resolves after `delayMs` (a real timer), or after one microtask when `delayMs <= 0` - either way, callers get a chance to observe/abort between chunks. */
function tick(delayMs: number): Promise<void> {
  if (delayMs > 0) {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return new Promise((resolve) => queueMicrotask(resolve))
}

export function createFakeAssistantEngine(options: FakeEngineOptions = {}): FakeAssistantEngine {
  const { reply = DEFAULT_FAKE_REPLY, chunkSize = 8, loadSteps = 3, failLoad = false, failChat = false, delayMs = 0 } = options

  const calls = { load: 0, chat: 0, abort: 0, unload: 0 }
  let lastRequest: AssistantChatRequest | null = null
  let loaded = false

  async function load(onProgress: (report: { progress: number; timeElapsed: number; text: string }) => void): Promise<void> {
    calls.load += 1
    if (loaded) return // §6.1: idempotent while already loaded.
    for (let step = 1; step <= loadSteps; step++) {
      await tick(delayMs)
      onProgress({ progress: step / loadSteps, timeElapsed: step * delayMs, text: `loading ${step}/${loadSteps}` })
    }
    if (failLoad) throw new Error('fakeAssistantEngine: simulated load failure')
    loaded = true
  }

  async function chat(request: AssistantChatRequest, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    calls.chat += 1
    lastRequest = request
    if (failChat) throw new Error('fakeAssistantEngine: simulated chat failure')

    let accumulated = ''
    for (let index = 0; index < reply.length; index += chunkSize) {
      if (signal?.aborted) break
      await tick(delayMs)
      if (signal?.aborted) break
      const delta = reply.slice(index, index + chunkSize)
      accumulated += delta
      onDelta(delta)
    }
    return accumulated
  }

  function abort(): void {
    calls.abort += 1
  }

  async function unload(): Promise<void> {
    calls.unload += 1
    loaded = false
  }

  return {
    load,
    chat,
    abort,
    unload,
    calls,
    get lastRequest() {
      return lastRequest
    },
    set lastRequest(value: AssistantChatRequest | null) {
      lastRequest = value
    },
  }
}
