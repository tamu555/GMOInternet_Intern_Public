/**
 * Conversation store (spec browser-ai.md §7, FR-06/07/08/14).
 *
 * §7.1: the model itself lives in IndexedDB and is genuinely persistent
 * across sessions/logouts - but the conversation never outlives the tab.
 * This module is the "conversation" half of that split: it is backed by
 * `sessionStorage[ASSISTANT_CHAT_STORAGE_KEY]`, which the browser already
 * clears on tab close (§7.2/§7.4), plus an explicit `clearAssistantChat()`
 * call from `AuthProvider.tsx` on every authenticated -> unauthenticated
 * transition (§7.3, FR-14).
 *
 * Follows `auth/additionalInfoState.ts`'s try/catch template: every
 * `sessionStorage` call is wrapped, `read*` validates the parsed shape
 * field-by-field (never a blind cast), and a private/quota-exceeded
 * `sessionStorage` degrades to an in-memory-only mirror (§7.4 ⚠️) rather than
 * throwing into the caller.
 */
import type { AssistantAction } from '../actions'
import { ASSISTANT_CHAT_STORAGE_KEY } from '../config/assistantConfig'
import type { IntentId } from '../routing/playbooks'
import type { RouteId } from '../routing/routeManifest'
import { CHAT_SCHEMA_VERSION } from '../types'
import type { ChatMessage, ChatSessionStore, Conversation, GoalState, NavigationSuggestion, WalkthroughState } from '../types'
import {
  completeStep as completeWalkthroughStepPure,
  createWalkthroughState as createWalkthroughStatePure,
  dismissWalkthrough as dismissWalkthroughPure,
  recordRouteVisit as advanceRouteVisit,
} from '../walkthrough/walkthroughState'
import { findWalkthroughTemplate } from '../walkthrough/walkthroughTemplates'
import type { WalkthroughId } from '../walkthrough/walkthroughTemplates'

function isValidNavigation(value: unknown): value is NavigationSuggestion {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.routeId === 'string' &&
    typeof candidate.resolvedPath === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.description === 'string'
  )
}

/**
 * v1.4 §3/§7.6: a light structural check, not a deep payload validation -
 * `AssistantAction.payload` is a union of 4 shapes and re-deriving all of
 * them here would duplicate `actions.ts` (owned by another wave). This only
 * guards against genuinely corrupt sessionStorage content; every action a
 * `ChatMessage` actually carries at runtime was built by `deriveActions()`,
 * never hand-constructed from storage.
 */
function isValidAssistantAction(value: unknown): value is AssistantAction {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.kind === 'string' &&
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  )
}

/** v1.4 §7.6/§29.2: `intent` is a validated `IntentId` or `null`; `slots` is a flat string map. */
function isValidGoalState(value: unknown): value is GoalState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.intent !== null && typeof candidate.intent !== 'string') return false
  if (typeof candidate.slots !== 'object' || candidate.slots === null || Array.isArray(candidate.slots)) return false
  if (!Object.values(candidate.slots as Record<string, unknown>).every((slotValue) => typeof slotValue === 'string')) {
    return false
  }
  if (typeof candidate.updatedAt !== 'number') return false
  return true
}

/**
 * v1.4 §7.6/plan §2: `templateId`/`dismissedAt` are validated at the level of
 * "the right JS type", not "a real `WalkthroughId`" - same tradeoff
 * `isValidNavigation` already makes for `routeId` (re-deriving
 * `WALKTHROUGH_TEMPLATES`'s id list here would duplicate
 * `walkthroughTemplates.ts`, which this module does not own the content of).
 */
function isValidWalkthroughState(value: unknown): value is WalkthroughState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.templateId !== 'string') return false
  if (!Array.isArray(candidate.completedStepIds) || !candidate.completedStepIds.every((id) => typeof id === 'string')) {
    return false
  }
  if (!Array.isArray(candidate.visitedRouteIds) || !candidate.visitedRouteIds.every((id) => typeof id === 'string')) {
    return false
  }
  if (typeof candidate.startedAt !== 'number') return false
  if (candidate.dismissedAt !== null && typeof candidate.dismissedAt !== 'number') return false
  return true
}

function isValidChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return false
  if (candidate.role !== 'user' && candidate.role !== 'assistant') return false
  if (typeof candidate.content !== 'string') return false
  if (typeof candidate.createdAt !== 'number') return false
  if (
    candidate.status !== 'pending' &&
    candidate.status !== 'streaming' &&
    candidate.status !== 'done' &&
    candidate.status !== 'failed'
  ) {
    return false
  }
  if (candidate.navigation !== undefined && !isValidNavigation(candidate.navigation)) return false
  // v1.4 §7.6: `actions` is optional (older stored messages have none) - only
  // reject it when PRESENT and malformed, never for being absent.
  if (candidate.actions !== undefined) {
    if (!Array.isArray(candidate.actions) || !candidate.actions.every(isValidAssistantAction)) return false
  }
  return true
}

function isValidConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string') return false
  if (typeof candidate.title !== 'string') return false
  if (typeof candidate.createdAt !== 'number') return false
  if (typeof candidate.updatedAt !== 'number') return false
  if (!Array.isArray(candidate.messages)) return false
  // v1.4 §7.6: `goal` is optional (older stored conversations have none) -
  // only reject it when PRESENT and malformed, never for being absent.
  if (candidate.goal !== undefined && !isValidGoalState(candidate.goal)) return false
  // v1.4 §7.6: `walkthrough` is optional (pre-walkthrough conversations have
  // none) - only reject it when PRESENT and malformed, never for being absent.
  if (candidate.walkthrough !== undefined && !isValidWalkthroughState(candidate.walkthrough)) return false
  return candidate.messages.every(isValidChatMessage)
}

/** §7.6: `schemaVersion` mismatch or parse failure -> discard and start empty. */
function isValidStore(value: unknown): value is ChatSessionStore {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== CHAT_SCHEMA_VERSION) return false
  if (typeof candidate.activeConversationId !== 'string') return false
  if (!Array.isArray(candidate.conversations)) return false
  return candidate.conversations.every(isValidConversation)
}

function createEmptyStore(): ChatSessionStore {
  return { schemaVersion: CHAT_SCHEMA_VERSION, activeConversationId: '', conversations: [] }
}

function readFromStorage(): ChatSessionStore | null {
  try {
    const raw = window.sessionStorage.getItem(ASSISTANT_CHAT_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidStore(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeToStorage(nextStore: ChatSessionStore): void {
  try {
    window.sessionStorage.setItem(ASSISTANT_CHAT_STORAGE_KEY, JSON.stringify(nextStore))
  } catch {
    // Private mode / quota exceeded (§7.4 ⚠️): the in-memory mirror below is
    // already updated, so the store keeps working for the rest of this tab -
    // it just won't survive a reload.
  }
}

/** In-memory mirror; the single source of truth `getChatSnapshot()` returns. */
let store: ChatSessionStore = readFromStorage() ?? createEmptyStore()

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Every mutation replaces `store` with a new, immutably-derived object and
 * persists + notifies exactly once. `getChatSnapshot()` between calls to
 * this always returns the same (`===`) reference, which is a hard
 * requirement for `useSyncExternalStore` (see the module doc + the
 * "stable snapshot" test).
 */
function commit(nextStore: ChatSessionStore, options: { persist?: boolean } = {}): void {
  store = nextStore
  if (options.persist !== false) writeToStorage(store)
  notify()
}

/** Stable-reference snapshot for `useSyncExternalStore`. */
export function getChatSnapshot(): ChatSessionStore {
  return store
}

/** Returns an unsubscribe function. */
export function subscribeChatStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * §7.3: removes the sessionStorage key AND resets the in-memory mirror.
 * Deliberately does not go through `commit()`'s normal persist path - that
 * would immediately re-write an (empty) entry back into sessionStorage,
 * which is not "removes the key" (FR-14's regression test asserts the key
 * itself is gone, not merely emptied).
 */
export function clearAssistantChat(): void {
  try {
    window.sessionStorage.removeItem(ASSISTANT_CHAT_STORAGE_KEY)
  } catch {
    // Ignore - memory is reset below regardless.
  }
  commit(createEmptyStore(), { persist: false })
}

export function createConversation(title?: string): Conversation {
  const now = Date.now()
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    // Real auto-generated titles come from `conversationTitleFromInput()`
    // once the first user message is sent (§7.5) - a brand-new conversation
    // has no utterance yet, so it starts untitled unless the caller passes one.
    title: title ?? '',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  commit({ ...store, activeConversationId: conversation.id, conversations: [...store.conversations, conversation] })
  return conversation
}

/**
 * §7.5: gives an existing conversation its auto-generated title, in place.
 *
 * ⚠️ Exists because the alternative was to delete the untitled conversation and
 * `createConversation(title)` a replacement, which `useAssistantChat` used to
 * do. That looked harmless - the conversation had no messages, so nothing was
 * lost - but `createConversation` APPENDS, so the tab silently jumped to the
 * end of the strip. With one tab open nobody could tell; with several open,
 * typing into the second tab visibly moved it to last position, which is what
 * the user reported. Renaming keeps both the position and the id stable.
 *
 * A no-op (same reference, no notify) when the title is unchanged or the id is
 * unknown, matching `recordRouteVisit`'s discipline for the same reason: this
 * must never churn `useSyncExternalStore`'s snapshot for nothing.
 */
export function renameConversation(id: string, title: string): void {
  const target = store.conversations.find((conversation) => conversation.id === id)
  if (!target || target.title === title) return
  const now = Date.now()
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === id ? { ...conversation, title, updatedAt: now } : conversation,
    ),
  })
}

/** §7.5/FR-08: returns the active conversation, creating one if none exists or the recorded id is stale. */
export function ensureActiveConversation(): Conversation {
  const active = store.conversations.find((conversation) => conversation.id === store.activeConversationId)
  if (active) return active
  return createConversation()
}

export function selectConversation(id: string): void {
  if (store.activeConversationId === id) return
  if (!store.conversations.some((conversation) => conversation.id === id)) return
  commit({ ...store, activeConversationId: id })
}

export function deleteConversation(id: string): void {
  if (!store.conversations.some((conversation) => conversation.id === id)) return
  const conversations = store.conversations.filter((conversation) => conversation.id !== id)
  const activeConversationId = store.activeConversationId === id ? (conversations[0]?.id ?? '') : store.activeConversationId
  commit({ ...store, conversations, activeConversationId })
}

export function deleteAllConversations(): void {
  commit({ ...store, conversations: [], activeConversationId: '' })
}

export function appendMessage(
  conversationId: string,
  message: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
): ChatMessage {
  const now = Date.now()
  const fullMessage: ChatMessage = {
    id: message.id ?? crypto.randomUUID(),
    createdAt: message.createdAt ?? now,
    role: message.role,
    content: message.content,
    status: message.status,
    ...(message.navigation !== undefined ? { navigation: message.navigation } : {}),
    ...(message.actions !== undefined ? { actions: message.actions } : {}),
  }
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, messages: [...conversation.messages, fullMessage], updatedAt: now }
        : conversation,
    ),
  })
  return fullMessage
}

/**
 * v1.4 §29.2/design contract §2.1 merge rule, applied after every successful
 * `guardDecision`: `intent` is overwritten only when the incoming `intent` is
 * neither `UNKNOWN` nor `OUT_OF_SCOPE` (an unrecognised/refused turn must
 * never erase what the conversation already learned); `slots` merge
 * key-by-key, with the new turn's values winning on a conflict.
 *
 * `patch` must only ever be built from values that already passed §11.4's
 * validation pipeline (a `guardDecision` result's own `decision.intent`/
 * `decision.slots`) - this function does not itself re-validate, by design
 * (§29.4: `GoalState` is never a place unvalidated model output lands,
 * because nothing upstream of this call is allowed to hand it any).
 */
export function mergeConversationGoal(conversationId: string, patch: { intent: IntentId | null; slots: Record<string, string> }): void {
  const now = Date.now()
  commit({
    ...store,
    conversations: store.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      const previousGoal = conversation.goal
      const keepPreviousIntent = patch.intent === null || patch.intent === 'UNKNOWN' || patch.intent === 'OUT_OF_SCOPE'
      const goal: GoalState = {
        intent: keepPreviousIntent ? (previousGoal?.intent ?? null) : patch.intent,
        slots: { ...(previousGoal?.slots ?? {}), ...patch.slots },
        updatedAt: now,
      }
      return { ...conversation, goal, updatedAt: now }
    }),
  })
}

/**
 * Guided Walkthrough store operations (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §2/§6, FR-21). The progress logic itself is the pure `walkthroughState.ts`
 * module - these functions only locate the right `Conversation`, delegate to
 * it, and re-commit. Each one is a true no-op (no `commit()`, no
 * `writeToStorage`, no `notify()`) when there is nothing to change, matching
 * the pure functions' own "same reference means unchanged" contract - most
 * importantly for `recordWalkthroughRouteVisit`, which fires on every
 * in-app navigation regardless of whether a walkthrough is even active.
 */
export function startWalkthrough(conversationId: string, templateId: WalkthroughId, now: number): void {
  const target = store.conversations.find((conversation) => conversation.id === conversationId)
  if (!target) return
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === conversationId
        ? { ...conversation, walkthrough: createWalkthroughStatePure(templateId, now), updatedAt: now }
        : conversation,
    ),
  })
}

export function completeWalkthroughStep(conversationId: string, stepId: string): void {
  const target = store.conversations.find((conversation) => conversation.id === conversationId)
  if (!target?.walkthrough) return
  const nextWalkthrough = completeWalkthroughStepPure(target.walkthrough, stepId)
  if (nextWalkthrough === target.walkthrough) return
  const now = Date.now()
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, walkthrough: nextWalkthrough, updatedAt: now } : conversation,
    ),
  })
}

/** "やめる" (plan §5) for the walkthrough attached to `conversationId` specifically - not necessarily the globally active conversation. */
export function dismissActiveWalkthrough(conversationId: string, now: number): void {
  const target = store.conversations.find((conversation) => conversation.id === conversationId)
  if (!target?.walkthrough) return
  const dismissed = dismissWalkthroughPure(target.walkthrough, now)
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, walkthrough: dismissed, updatedAt: now } : conversation,
    ),
  })
}

/**
 * Deliberately takes NO conversation id: `AssistantLauncher` calls this from
 * `useLocation()` on every in-app navigation, even while the walkthrough
 * modal is closed (plan §1 - this auto-detection is the whole point of the
 * feature), so it always targets the currently ACTIVE conversation's
 * walkthrough rather than requiring every call site to plumb an id through.
 */
export function recordWalkthroughRouteVisit(routeId: RouteId): void {
  const activeConversation = store.conversations.find((conversation) => conversation.id === store.activeConversationId)
  if (!activeConversation?.walkthrough) return
  // The template is resolved here (not passed in) because `recordRouteVisit`
  // now needs it to tell "the user went here to do the current step" from
  // "the user once happened to be here" - see its own doc. An unknown
  // templateId (data from an older build) simply records nothing rather than
  // completing steps on evidence this build cannot interpret.
  const template = findWalkthroughTemplate(activeConversation.walkthrough.templateId)
  if (!template) return
  const nextWalkthrough = advanceRouteVisit(template, activeConversation.walkthrough, routeId)
  if (nextWalkthrough === activeConversation.walkthrough) return
  commit({
    ...store,
    conversations: store.conversations.map((conversation) =>
      conversation.id === activeConversation.id ? { ...conversation, walkthrough: nextWalkthrough, updatedAt: Date.now() } : conversation,
    ),
  })
}

export function updateMessage(conversationId: string, messageId: string, patch: Partial<Omit<ChatMessage, 'id'>>): void {
  const now = Date.now()
  commit({
    ...store,
    conversations: store.conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation
      return {
        ...conversation,
        updatedAt: now,
        messages: conversation.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
      }
    }),
  })
}

/** §7.5: "最初のユーザー発言の先頭 20 文字". */
const TITLE_MAX_CHARS = 20

/**
 * §7.5: the auto-generated conversation title, the first 20 characters of
 * the first user utterance - counted by Unicode code point (`Array.from`),
 * not UTF-16 code unit, so a surrogate-pair emoji counts as one character
 * and is never split in half. Never produced by the LLM. A title that had to
 * be cut ends in an ellipsis so the tab strip shows it was truncated.
 */
export function conversationTitleFromInput(text: string): string {
  const codePoints = Array.from(text)
  if (codePoints.length <= TITLE_MAX_CHARS) return text
  // The ellipsis is appended, not counted against the 20 characters, so the
  // §7.5 "先頭 20 文字" rule still describes exactly what is kept - it only
  // makes a cut title visibly a cut title in the tab strip.
  return `${codePoints.slice(0, TITLE_MAX_CHARS).join('')}…`
}

/**
 * Test-only. Re-derives the in-memory mirror from whatever is currently in
 * `sessionStorage` - i.e. simulates this module being freshly re-imported in
 * the same tab (a reload), WITHOUT clearing storage. Tests that need a
 * truly empty starting point should clear `sessionStorage` themselves first
 * (e.g. in `beforeEach`) before calling this.
 */
export function resetChatStoreForTest(): void {
  store = readFromStorage() ?? createEmptyStore()
  listeners.clear()
}
