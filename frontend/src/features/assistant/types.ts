/**
 * Shared type contract for the assistant feature (spec browser-ai.md).
 * Everything here is a compile-time-only type/const boundary that later
 * waves (security/prompt/engine/UI) code against; there is no runtime logic
 * beyond `CHAT_SCHEMA_VERSION`.
 */
import type { AssistantAction } from './actions'
import type { IntentId } from './routing/playbooks'
import type { RouteId } from './routing/routeManifest'
import type { WalkthroughId } from './walkthrough/walkthroughTemplates'

/** WebLLM model lifecycle state (§6.2). */
export type ModelStatus =
  | 'NOT_STARTED'
  /** WebGPU detection, storage check, connection check, cache lookup (hasModelInCache). */
  | 'CHECKING'
  /** Waiting for user consent to download on a slow connection (§17.2). */
  | 'AWAITING_CONSENT'
  | 'DOWNLOADING'
  | 'INITIALIZING'
  | 'READY'
  /** No WebGPU, or ASSISTANT_CONFIG.enabled === false. */
  | 'UNSUPPORTED'
  | 'ERROR'

/** §7.6 verbatim. */
export interface Conversation {
  /** crypto.randomUUID() */
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /**
   * v1.4 §7.6 additive extension (design contract §2.1), same precedent as
   * `NavigationSuggestion.intent`: what the assistant has learned about this
   * conversation's goal so far. Optional - `schemaVersion` stays `1` and
   * readers of an older stored `ChatSessionStore` must tolerate its absence.
   */
  goal?: GoalState
  /**
   * v1.4 §7.6 additive extension (`.agents/docs/research/assistant-walkthrough-plan.md`
   * §2/§6, spec browser-ai.md §34): the active Guided Walkthrough for this
   * conversation, if the user has started one. Optional for the same reason
   * as `goal`/`actions` above - `schemaVersion` stays `1`, and readers of a
   * conversation stored before this feature shipped must tolerate its
   * absence.
   */
  walkthrough?: WalkthroughState
}

/** §7.6 verbatim. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: 'pending' | 'streaming' | 'done' | 'failed'
  /** Assistant messages only - see §13.1. */
  navigation?: NavigationSuggestion
  /**
   * v1.4 §7.6 additive extension (design contract §3): the app-derived
   * Quick Action buttons for this message. Assistant messages only. Optional
   * for the same reason as `Conversation.goal` - older stored messages have
   * no `actions` and must render fine without them.
   */
  actions?: AssistantAction[]
}

/**
 * v1.4 design contract §2.1 verbatim: what the assistant has learned about
 * this conversation's goal so far, accumulated across turns. `slots` only
 * ever holds already-validated values (a Playbook `allowedValues` member, or
 * a `kind: 'label'` value that passed `validateLabelSlotValue`) - it is
 * never a place where unvalidated model output lands.
 */
export interface GoalState {
  intent: IntentId | null
  /** Only keys declared by a Playbook's requiredSlots. */
  slots: Record<string, string>
  updatedAt: number
}

/** §7.6 verbatim. */
export interface NavigationSuggestion {
  routeId: RouteId
  /** Path already resolved from the Manifest. */
  resolvedPath: string
  title: string
  description: string
  /**
   * Playbook the decision came from, so NavigationCard can render the
   * Playbook's guidance/warnings (§13.1: "UI 側が Manifest と Playbook から生成する").
   * Optional because §7.6's literal shape has four fields; this is an additive
   * extension needed to keep the card renderable after a sessionStorage reload.
   */
  intent?: IntentId
}

/** §7.6 verbatim. Stored at sessionStorage[ASSISTANT_CHAT_STORAGE_KEY]. */
export interface ChatSessionStore {
  schemaVersion: 1
  activeConversationId: string
  conversations: Conversation[]
}

/** §7.6: the current, and so far only, ChatSessionStore.schemaVersion value. */
export const CHAT_SCHEMA_VERSION = 1

/** §11.1 verbatim. */
export interface AssistantDecision {
  intent: IntentId
  reply: string
  routeId: RouteId | null
  /** Playbook.requiredSlots[].key -> a value from that slot's allowedValues. */
  slots: Record<string, string>
  /** 0-1, a secondary signal only - see §11.6. */
  confidence: number
  needsClarification: boolean
}

/**
 * Guided Walkthrough progress for one `Conversation`
 * (`.agents/docs/research/assistant-walkthrough-plan.md` §2 verbatim). Declared
 * here rather than in `walkthrough/walkthroughTemplates.ts` because this is the
 * acyclic direction: `walkthroughTemplates.ts` never imports from `types.ts`,
 * so `types.ts` can freely import its `WalkthroughId` type without creating a
 * cycle (`walkthroughState.ts`, which needs both, imports `WalkthroughState`
 * from here and `WalkthroughId`/`WalkthroughTemplate` from there).
 *
 * `currentStepIndex` is deliberately NOT a field here - it is always derived
 * from `completedStepIds`/`visitedRouteIds` (see `walkthroughState.ts`'s
 * `currentStepIndex()`), so a stored index can never drift out of sync with
 * what is actually complete.
 */
export interface WalkthroughState {
  templateId: WalkthroughId
  /** Step ids the user explicitly completed (manually, or as an override of an app-observed step). */
  completedStepIds: string[]
  /** RouteIds `AssistantLauncher` has observed the user visit since this walkthrough started (FR-21). */
  visitedRouteIds: RouteId[]
  startedAt: number
  /** Set by "やめる" (plan §5); `null` while active. Dismissing preserves progress so it can resume. */
  dismissedAt: number | null
}

/** §13.6 verbatim. Built by AssistantLauncher from useLocation()/useParams(). */
export interface PageContext {
  /** RouteId matching the current page (Manifest reverse lookup), null if none. */
  routeId: RouteId | null
  /** Present on /mypage/domains/:domainName and /domains/:domainName/dns. */
  domain?: string
}

/** §12.4. */
export type ScopeVerdict = 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'SUSPICIOUS'

export interface AssistantChatRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

/**
 * Abstraction over the WebLLM Web Worker engine (§15.2: `load`/`chat`/`abort`/
 * `unload`). jsdom has no WebGPU or real Worker support, so vitest injects a
 * Fake implementation of this interface in place of the real
 * `engine/assistantEngine.ts` - this is the seam later waves' component tests
 * use instead of mocking WebLLM itself.
 */
export interface AssistantEngine {
  /** Reports WebLLM's InitProgressReport shape as the model loads. */
  load(onProgress: (report: { progress: number; timeElapsed: number; text: string }) => void): Promise<void>
  /** Streams the reply via onDelta; resolves with the full text. */
  chat(request: AssistantChatRequest, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<string>
  abort(): void
  unload(): Promise<void>
}
