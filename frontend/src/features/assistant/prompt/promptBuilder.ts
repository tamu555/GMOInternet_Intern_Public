/**
 * Chat request assembly (spec browser-ai.md §15.1, §15.4, §15.5). Combines
 * the System Prompt, a bounded window of prior conversation turns, and the
 * current user turn into the exact message array WebLLM's
 * `chat.completions.create` expects.
 */
import { ASSISTANT_CONFIG } from '../config/assistantConfig'
import type { AssistantPlaybook } from '../routing/playbooks'
import type { AssistantChatRequest, ChatMessage, GoalState, PageContext } from '../types'
import { buildSystemPrompt, SYSTEM_PROMPT_HEADINGS } from './systemPrompt'

/** §15.5: "上限 20" - `ASSISTANT_CONFIG.inference.historyTurns` is clamped to this. */
export const MAX_HISTORY_TURNS_CAP = 20

export interface PromptBuildInput {
  /** Already normalized by the Input Guard (NFKC, control chars stripped, length-limited - §12.3). */
  userInput: string
  context: PageContext
  /** Full conversation, oldest first. */
  history: readonly ChatMessage[]
  /** When the caller already knows the intent; v1 passes null/omits it. */
  playbook?: AssistantPlaybook | null
  /**
   * v1.4 (design contract §2.1): the conversation's accumulated `GoalState`,
   * passed straight through to `buildSystemPrompt` so the model gets a
   * summary of what it has already learned. Omitting it is unchanged from
   * v1.3 behaviour.
   */
  goal?: GoalState | null
}

/**
 * §15.1: only `status === 'done'` messages ever re-enter a prompt -
 * `'pending'`/`'streaming'`/`'failed'` messages are excluded (a pending
 * message hasn't been answered yet, a streaming one is mid-flight, and a
 * failed one was never validated).
 */
function doneMessagesOnly(history: readonly ChatMessage[]): ChatMessage[] {
  return history.filter((message) => message.status === 'done')
}

/**
 * A "turn" is one user message plus its assistant reply (§15.1: "直近
 * historyTurns" turns, counted by user message). Finds the index of the
 * Nth-from-last user message and returns everything from there to the end,
 * which is exactly the last `turns` turns regardless of whether every user
 * message actually got an assistant reply.
 */
function takeLastTurns(doneHistory: readonly ChatMessage[], turns: number): ChatMessage[] {
  if (turns <= 0) return []
  let userMessagesSeen = 0
  let startIndex = doneHistory.length
  for (let i = doneHistory.length - 1; i >= 0; i--) {
    if (doneHistory[i]!.role === 'user') {
      userMessagesSeen++
      startIndex = i
      if (userMessagesSeen === turns) break
    }
  }
  return doneHistory.slice(startIndex)
}

/**
 * §15.1/§15.5. Builds the full `AssistantChatRequest.messages` array:
 * 1 system message, the last `historyTurns` turns of history, then the
 * current user turn.
 *
 * §12.3: the user's text is NEVER string-concatenated into the system
 * message - it always arrives as its own `role: 'user'` message, both for
 * history turns and for the current input.
 */
export function buildChatRequest(input: PromptBuildInput): AssistantChatRequest {
  const systemMessage = {
    role: 'system' as const,
    content: buildSystemPrompt(input.context, input.playbook ?? null, input.goal ?? null),
  }

  const historyTurns = Math.min(ASSISTANT_CONFIG.inference.historyTurns, MAX_HISTORY_TURNS_CAP)
  const doneHistory = doneMessagesOnly(input.history)
  const windowedHistory = takeLastTurns(doneHistory, historyTurns)

  // Stored `ChatMessage.content` for an assistant message is already
  // body-only (the header block from the wire format, §11.3, was stripped by
  // the Output Parser before saving) - it is fed back verbatim, never
  // re-wrapped with headers.
  const historyMessages = windowedHistory.map((message) => ({ role: message.role, content: message.content }))

  const currentUserMessage = { role: 'user' as const, content: input.userInput }

  return { messages: [systemMessage, ...historyMessages, currentUserMessage] }
}

/**
 * §15.4 exactly: temperature/top_p/max_tokens come from
 * `ASSISTANT_CONFIG.inference` (never hard-coded here), `stream` is always
 * `true`, and thinking is always off (`extra_body.enable_thinking: false`,
 * the WebLLM-specific field `engine.ts` reads for this).
 */
/**
 * Layer 2 of the §12.7 System-Prompt-leak defence (OWASP LLM07): decoding stops
 * the moment the model starts a line that reproduces one of the System Prompt's
 * own section headings. This matters even though `outputGuard.sanitizeReply()`
 * strips such an echo afterwards, because the body is streamed to the UI token
 * by token (§15.3) - without a stop sequence the user would watch the leak
 * appear before it was removed at the end of the turn.
 *
 * Each heading is bounded by a newline on BOTH sides, which is how it appears
 * in the System Prompt: alone on its own line. The trailing newline is what
 * makes this safe - `"\nDNS:"` alone also matches a perfectly good answer that
 * happens to begin a line with `DNS: レコード設定モードから…`, which would cut
 * the reply to nothing and show §11.5's fixed message. That regression was
 * real: it broke exactly the DNS questions this assistant exists to answer.
 */
export const SYSTEM_PROMPT_ECHO_STOP_SEQUENCES: readonly string[] = SYSTEM_PROMPT_HEADINGS.map(
  (heading) => `\n${heading}\n`,
)

/**
 * The `CONTEXT:` block's own machine keys (§12.5), stopped on directly rather
 * than only via the `\nCONTEXT:\n` heading above.
 *
 * A leak does not have to reproduce the heading to be a leak: the model can
 * emit `has_selected_domain=false` in the middle of an otherwise normal answer,
 * with no heading anywhere, and the heading-shaped stop sequences never fire.
 * These three identifiers are internal and appear in no legitimate Japanese
 * guidance sentence, so stopping the moment one starts costs nothing and is the
 * earliest point at which the leak can be cut - earlier than
 * `sanitizeStreamingBody`, which can only hide it once it has been decoded.
 */
export const CONTEXT_KEY_STOP_SEQUENCES: readonly string[] = [
  'current_page=',
  'has_selected_domain=',
  'known_so_far=',
]

export function generationOptions(): {
  temperature: number
  top_p: number
  max_tokens: number
  stream: true
  stop: string[]
  extra_body: { enable_thinking: false }
} {
  const { temperature, topP, maxTokens } = ASSISTANT_CONFIG.inference
  return {
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
    stream: true,
    stop: [...SYSTEM_PROMPT_ECHO_STOP_SEQUENCES, ...CONTEXT_KEY_STOP_SEQUENCES],
    extra_body: { enable_thinking: false },
  }
}
