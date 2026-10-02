/**
 * WebLLM Web Worker entry point (spec browser-ai.md §15.2, §6.1).
 *
 * This file is loaded as a *module Web Worker* only, via:
 *   new Worker(new URL('./assistantWorker.ts', import.meta.url), { type: 'module' })
 * (see `assistantEngine.ts`'s `createWebLlmEngine().load()`). It must never be
 * imported from the main thread - importing it would pull WebLLM/WebGPU code
 * into the main bundle and defeat the whole point of running inference off
 * the main thread (§15.2: "LLM 処理は Main Thread で直接実行しない").
 *
 * Kept dependency-free beyond `@mlc-ai/web-llm` itself, exactly the shape of
 * the WebLLM README's worker example: construct the handler, forward
 * `onmessage` to it. All protocol logic lives inside `WebWorkerMLCEngineHandler`.
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()

self.onmessage = (event: MessageEvent) => {
  handler.onmessage(event)
}
