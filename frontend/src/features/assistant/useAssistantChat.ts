/**
 * §15.1 chat pipeline controller, plus §6.4.1's pending-message processing and
 * §15.6's conversation-switch abort semantics. `AssistantModalBody` is the
 * only intended caller (one hook instance per open modal, mirroring
 * `RecipeDialog`'s "state lives inside the openable dialog body" convention -
 * see `AssistantModal.tsx`): this keeps a single `AssistantEngine` (from
 * `store/modelStore.ts`, itself a tab-wide singleton, §15.6) driven by at
 * most one generation at a time from this hook.
 *
 * Design notes (see the wave report for the full rationale):
 * - §6.4.1 pending messages: the *user* message itself is stored with
 *   `status: 'pending'` while the model is not READY (never a separate
 *   assistant placeholder). `sendMessage()` only ever runs §15.1 steps 1-2
 *   (normalize, append, title); steps 3-8 (scope check through streaming) are
 *   factored into `processUserTurn()`, called either immediately (already
 *   READY) or later by the pending-message effect once the model reaches
 *   READY - so a message that starts pending is scope-checked/generated
 *   exactly once, at the point it is actually processed.
 * - §7.5 conversation titles: no conversation is ever eagerly created on
 *   mount, so the common case (the very first message of a brand new modal)
 *   creates the conversation with its title already set - no churn. An
 *   existing, still-empty, still-untitled conversation (one just created via
 *   `newConversation()`, the "+" button) is RENAMED in place
 *   (`chatStore.renameConversation`). It used to be deleted and recreated with
 *   the title instead, because the store had no rename; that lost no data but
 *   silently moved the tab to the end of the strip, since
 *   `createConversation` appends - see `conversationForNewTurn`.
 * - §15.6 conversation switch / unmount: aborts the in-flight generation via
 *   both the `AbortSignal` passed to `engine.chat()` and `engine.abort()`.
 *   Only a real §16 timeout replaces the message content with
 *   `GENERATION_TIMEOUT_MESSAGE`; a user-initiated interruption (switch, new
 *   conversation, delete, unmount) leaves whatever text had already streamed
 *   in place and only flips `status` to `'failed'` - §15.6 only specifies the
 *   status, not a content replacement, and overwriting a partial answer with
 *   an unrelated "model failed to load" message would be actively wrong.
 * - FR-17: this module never calls `fetch`, a Callable, or any network API -
 *   every side effect goes through `store/chatStore.ts`, `store/modelStore.ts`
 *   and the injected `AssistantEngine`.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AssistantAction, SetSlotPayload, StartWalkthroughPayload, SuggestDomainsPayload } from './actions'
import { deriveActions, fallbackActions, purposeShortcutActions } from './actions'
import {
  askedDomainAvailableMessage,
  askedDomainTakenMessage,
  askedDomainUnknownMessage,
  DECISION_VALIDATION_FAILED_MESSAGE,
  DOMAIN_CANDIDATES_EMPTY_MESSAGE,
  DOMAIN_CANDIDATES_LOADING_MESSAGE,
  DOMAIN_CANDIDATES_NO_MORE_MESSAGE,
  DOMAIN_CANDIDATES_READY_MESSAGE,
  GENERATION_TIMEOUT_MESSAGE,
  MODEL_LOAD_FAILED_MESSAGE,
  RULE_BASED_FALLBACK_PREFIX,
  SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE,
  SUGGEST_DOMAINS_FAILED_MESSAGE,
  SUGGEST_ALTERNATIVES_ACTION_LABEL,
  SUGGEST_MORE_DOMAINS_ACTION_LABEL,
} from './assistantMessages'
import { ASSISTANT_CONFIG } from './config/assistantConfig'
import { emitAssistantEvent } from './events'
import { createStreamingParser, toDecisionCandidate } from './prompt/outputParser'
import { buildChatRequest } from './prompt/promptBuilder'
import { findPlaybook } from './routing/playbooks'
import type { AssistantPlaybook, AssistantSlot, IntentId } from './routing/playbooks'
import { classifyIntent, hasPostAcquisitionSignal } from './routing/ruleBasedIntent'
import type { RuleBasedGuess } from './routing/ruleBasedIntent'
import { normalizeUserInput } from './security/inputGuard'
import { sanitizeStreamingBody } from './security/outputGuard'
import { guardDecision } from './security/routeValidator'
import { detectScope, eventTypeForScope, fixedReplyForScope } from './security/scopeDetector'
import {
  appendMessage,
  conversationTitleFromInput,
  createConversation,
  deleteAllConversations as storeDeleteAllConversations,
  deleteConversation as storeDeleteConversation,
  getChatSnapshot,
  mergeConversationGoal,
  renameConversation,
  startWalkthrough,
  selectConversation as storeSelectConversation,
  subscribeChatStore,
  updateMessage,
} from './store/chatStore'
import {
  getAssistantEngine,
  getModelSnapshot,
  grantDownloadConsent,
  retryModelLoad as storeRetryModelLoad,
  subscribeModelState,
  type ModelState,
} from './store/modelStore'
import { nextPendingMessage } from './store/pendingQueue'
import { checkAskedDomain, parseAskedDomain, type AskedDomain } from './suggest/askedDomain'
import { suggestDomains, type DomainSuggestionResult } from './suggest/domainSuggestion'
import type { AssistantDecision, ChatSessionStore, Conversation, NavigationSuggestion, PageContext } from './types'

/**
 * v1.4 (design contract §4.2, FR-17): `suggestDomains()` may ONLY ever be
 * invoked from `runAction`'s `SUGGEST_DOMAINS` branch below - i.e. only after
 * an explicit user click on a Quick Action button - never from an effect,
 * model load, or message processing. This module-level indirection is the
 * seam `useAssistantChat.test.tsx`'s FR-17 test uses to assert that, without
 * mocking `fetch`/the network: mirrors `store/modelStore.ts`'s
 * `setEngineFactoryForTest`.
 */
type SuggestDomainsFn = typeof suggestDomains
let suggestDomainsImpl: SuggestDomainsFn = suggestDomains

/** Test-only. See the module doc above. */
export function setSuggestDomainsForTest(fn: SuggestDomainsFn | null): void {
  suggestDomainsImpl = fn ?? suggestDomains
}

/**
 * Same seam for the specific-domain availability check (§8.4's other
 * read-only Callable path). See `runAskedDomainCheck` for why this one may run
 * from a typed message while `suggestDomainsImpl` historically could not.
 */
type CheckAskedDomainFn = typeof checkAskedDomain
let checkAskedDomainImpl: CheckAskedDomainFn = checkAskedDomain

/** Test-only. */
export function setCheckAskedDomainForTest(fn: CheckAskedDomainFn | null): void {
  checkAskedDomainImpl = fn ?? checkAskedDomain
}

/**
 * v1.4 (design contract §3): the hook's own state for the most recent
 * SUGGEST_DOMAINS click - see `MessageListSuggestionState` in
 * `MessageList.tsx` (same shape, kept independent so this module does not
 * depend on a UI component's exported type).
 */
export interface AssistantSuggestionState {
  status: 'idle' | 'loading' | 'done' | 'error'
  result: DomainSuggestionResult | null
  /** Which assistant message this loading/result state belongs to. */
  messageId: string | null
}

const IDLE_SUGGESTION: AssistantSuggestionState = { status: 'idle', result: null, messageId: null }

export interface UseAssistantChatResult {
  store: ChatSessionStore
  activeConversation: Conversation
  modelState: ModelState
  busy: boolean
  sendMessage: (rawInput: string) => void
  newConversation: () => void
  selectConversation: (id: string) => void
  deleteConversation: (id: string) => void
  deleteAllConversations: () => void
  retryModelLoad: () => void
  grantConsent: () => void
  /** v1.4 (design contract §3/§30): runs one app-derived Quick Action - see the module doc on each `AssistantActionKind` branch below. */
  runAction: (action: AssistantAction) => void
  /** v1.4 (design contract §4.2): the most recent SUGGEST_DOMAINS click's state. */
  suggestion: AssistantSuggestionState
}

/**
 * Returned for the brief window before the mount effect below has created
 * the first conversation (or right after `deleteAllConversations()`). Never
 * mutated and never passed to a store function - purely a same-shape stand-in
 * so `activeConversation` can stay non-nullable in the public result.
 */
const EMPTY_CONVERSATION: Conversation = { id: '', title: '', createdAt: 0, updatedAt: 0, messages: [] }

/** `AbortController.abort(reason)` reasons this hook uses, so the post-abort handling can tell a §16 timeout apart from a §15.6 user-initiated interruption. */
const TIMEOUT_ABORT_REASON = 'assistant-generation-timeout'
const INTERRUPTED_ABORT_REASON = 'assistant-generation-interrupted'

/**
 * DEV-only diagnostic for the §11.5 path. Without it, "the AI never manages to
 * guide me" is indistinguishable from "the model answered but one header line
 * was malformed" - the user only ever sees the same fixed message. Never runs
 * in a production build, and the raw text is only logged, never rendered
 * (§12.7).
 */
function logValidationFailure(reason: string, raw: string): void {
  if (!import.meta.env.DEV) return
  console.debug('[assistant] decision rejected:', reason, '\n--- raw model output ---\n', raw)
}

function activeConversationFrom(chatStore: ChatSessionStore): Conversation | null {
  return chatStore.conversations.find((conversation) => conversation.id === chatStore.activeConversationId) ?? null
}

/**
 * Text fed to `deriveActions`'s `labelHintText` parameter (`actions.ts`'s
 * `suggestDomainsActions` -> `routing/domainLabelHints.ts`'s
 * `labelHintsFromText`): every user message in the conversation so far,
 * chronological order, joined with a newline - not only the conversation's
 * first message (pre-v1.5 behaviour).
 *
 * v1.5 "ask what kind of site" revision: the purpose word that answers
 * `SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE` (typed freely, or clicked from a
 * `purposeShortcutActions()` button - see `runAction`'s SUGGEST_DOMAINS
 * branch below) is a LATER message, not the conversation's opening one (e.g.
 * "ドメインを取得したい" names no purpose; the "ポートフォリオ" that answers the
 * follow-up question, several turns later, does). Scanning every user
 * message is what lets that later answer still reach `labelHintsFromText` on
 * a subsequent turn. Joining does not change `labelHintsFromText`'s own
 * output ORDER (curated dictionary hits first, then ASCII words, per its
 * module doc) - it only changes what text is searched.
 */
function labelHintTextOf(conversation: Conversation | undefined): string | null {
  if (!conversation) return null
  const userMessages = conversation.messages.filter((message) => message.role === 'user').map((message) => message.content)
  return userMessages.length > 0 ? userMessages.join('\n') : null
}

/**
 * "Never dead-end" fallback (team-lead directive, not yet in browser-ai.md):
 * confidence assigned to a `routing/ruleBasedIntent.ts` guess turned into a
 * decision candidate below. Comfortably above `ASSISTANT_CONFIG.thresholds.minConfidence`
 * (0.5, §11.6) so the guess is never itself rejected by `guardDecision`'s own
 * confidence floor - the rule-based path has no genuine self-reported
 * confidence, so this is a fixed, deliberately unambitious value, same
 * precedent as `outputParser.ts`'s `DEFAULT_CONFIDENCE` for an omitted
 * `confidence:` line.
 */
const RULE_BASED_FALLBACK_CONFIDENCE = 0.6

/**
 * The same "first unfilled REQUIRED enum slot" rule `actions.ts`'s
 * `setSlotActions` (rule 1) uses, reused here to decide whether a rule-based
 * guess's reply should be the Playbook's clarifying question or its guidance.
 */
function firstUnfilledRequiredSlot(playbook: AssistantPlaybook, slots: Readonly<Record<string, string>>): AssistantSlot | undefined {
  return playbook.requiredSlots.find(
    (slot) => (slot.kind ?? 'enum') === 'enum' && slot.optional !== true && slots[slot.key] === undefined,
  )
}

/**
 * Turns an already-known `intent` + `slots` into a decision candidate shaped
 * exactly like `toDecisionCandidate`'s output, so it can run through the SAME
 * `guardDecision` pipeline as a real model decision (§11.4) - neither the
 * "never dead-end" fallback nor the deterministic Quick Action path skips
 * schema validation, slot filtering, route resolution, or reply sanitization.
 * `null` only in the defensive case where `intent` has no Playbook (cannot
 * happen in practice: every `IntentId` reaching here comes either from
 * `classifyIntent` or from a `SetSlotPayload.intent` the app itself wrote, and
 * both draw on `ASSISTANT_PLAYBOOKS`).
 */
function buildResolvedCandidate(intent: IntentId, slots: Record<string, string>): Record<string, unknown> | null {
  const playbook = findPlaybook(intent)
  if (!playbook) return null
  const unfilledSlot = firstUnfilledRequiredSlot(playbook, slots)
  const needsClarification = unfilledSlot !== undefined
  return {
    intent,
    reply: needsClarification ? unfilledSlot.question : playbook.guidance,
    routeId: null,
    slots,
    confidence: RULE_BASED_FALLBACK_CONFIDENCE,
    needsClarification,
  }
}

function buildRuleBasedCandidate(guess: RuleBasedGuess): Record<string, unknown> | null {
  return buildResolvedCandidate(guess.intent, guess.slots)
}

/**
 * Everything that happens once a `guardDecision` has succeeded: merge the
 * validated intent/slots into the conversation's `GoalState` (§29.2), derive
 * Quick Actions from the UPDATED goal (§30), and hand the caller the message
 * fields to write. Shared by all three success paths (a model decision, the
 * rule-based fallback, and a deterministic Quick Action) so they cannot drift
 * on goal merging or action derivation - the only thing that differs between
 * them is the reply prefix and which message gets updated.
 */
function applyGuardedDecision(
  conversationId: string,
  guarded: { decision: AssistantDecision; navigation: NavigationSuggestion | null },
  replyPrefix: string | null,
): { content: string; status: 'done'; navigation?: NavigationSuggestion; actions?: AssistantAction[] } {
  const { decision, navigation } = guarded
  mergeConversationGoal(conversationId, { intent: decision.intent, slots: decision.slots })
  const updatedConversation = getChatSnapshot().conversations.find((entry) => entry.id === conversationId)
  const actions = deriveActions(
    decision,
    updatedConversation?.goal ?? null,
    findPlaybook(decision.intent) ?? null,
    labelHintTextOf(updatedConversation),
    updatedConversation?.walkthrough != null && updatedConversation.walkthrough.dismissedAt === null,
  )
  return {
    content: replyPrefix === null ? decision.reply : `${replyPrefix}\n${decision.reply}`,
    status: 'done',
    ...(navigation ? { navigation: { ...navigation, intent: decision.intent } } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  }
}

/**
 * Single entry point for every "the model gave us nothing usable this turn"
 * case: a parse failure, a `guardDecision` rejection, or a successful
 * decision whose `intent` came back `UNKNOWN` with zero derived actions (see
 * the three call sites in `processUserTurn` below). Replaces the old
 * behaviour of unconditionally showing §11.5's fixed
 * `DECISION_VALIDATION_FAILED_MESSAGE` with no next step.
 *
 * 1. Try `routing/ruleBasedIntent.ts`'s deterministic `classifyIntent` on the
 *    user's own text. A guess is built into a decision candidate and run
 *    through the real `guardDecision` guard (§11.4) exactly like a model
 *    decision, then merged into `GoalState` (§29.2) and given Quick Actions
 *    (§30) the same way a successful model turn is - see the success branch
 *    of `processUserTurn`. Its reply is prefixed with an honest
 *    "this is a simplified answer" note (`RULE_BASED_FALLBACK_PREFIX`).
 * 2. If `classifyIntent` found nothing, or the guess-based candidate somehow
 *    still failed `guardDecision`, fall back to §11.5's fixed message - but
 *    now always paired with `fallbackActions` (`actions.ts`), a small, always
 *    non-empty set of generic Quick Actions, so the apology is never a true
 *    dead end.
 */
function applyRuleBasedGuess(conversationId: string, messageId: string, userInput: string, context: PageContext): boolean {
  const guess = classifyIntent(userInput)
  const candidate = guess ? buildRuleBasedCandidate(guess) : null
  const guarded = candidate ? guardDecision(candidate, context) : null
  if (!guarded?.ok) return false
  updateMessage(conversationId, messageId, applyGuardedDecision(conversationId, guarded.value, RULE_BASED_FALLBACK_PREFIX))
  return true
}

function applyFallback(
  conversationId: string,
  messageId: string,
  userInput: string,
  context: PageContext,
  reason: string,
  raw: string,
): void {
  logValidationFailure(reason, raw)
  emitAssistantEvent({ type: 'output_validation_failed' })

  if (applyRuleBasedGuess(conversationId, messageId, userInput, context)) return

  updateMessage(conversationId, messageId, {
    content: DECISION_VALIDATION_FAILED_MESSAGE,
    status: 'done',
    actions: fallbackActions(userInput),
  })
}

/**
 * "The model's answer parsed and validated, but it is guiding the user to the
 * wrong screen."
 *
 * ⚠️ The browser report this exists for: 「CloudflareでDNSを変えたい」 produced a
 * well-formed `SEARCH_DOMAIN` decision, so §11.4 accepted it and the user was
 * shown a ドメイン検索 Navigation Card plus 「ドメイン候補を探す」 buttons - for a
 * request about changing DNS on a domain they already own. Nothing was
 * malformed; the model had simply classified it wrong, and every guard
 * downstream of the intent can only check that the route is legal FOR THAT
 * INTENT, never that the intent itself matched what the user asked.
 *
 * `routing/ruleBasedIntent.ts` is the second opinion. Its intent accuracy is
 * measured (98.7% on the 500-case corpus, with zero hits on the 50
 * `out_of_scope` cases); the 0.6B model's is not measured at all, and this is
 * the same 「候補提案のコアはルールベース、AIは限定適用」 split the project's own
 * decision log calls for.
 *
 * Deliberately narrow, and narrowed once more after it misfired. Three
 * conditions must all hold:
 *
 * 1. The model actually proposed a destination (`navigation !== null`). No card
 *    means no wrong screen to send anyone to.
 * 2. That destination is not in the rule-based reading's `allowedRoutes` at
 *    all - not merely a different route, an impossible one.
 * 3. **The rule-based guess extracted at least one slot value, OR the text
 *    carries an explicit post-acquisition signal.** This is what separates a
 *    strong reading from a generic one. 「CloudflareでDNSを変えたい」 yields
 *    `provider=cloudflare` - the user named a concrete thing and the model
 *    ignored it. 「パン屋のサイトを作りたい」 yields CONNECT_WEBSITE with no
 *    slots, which is a defensible reading but so is the model's SEARCH_DOMAIN
 *    ("you'll need a domain first"), and an early version of this function
 *    overrode that perfectly good answer with a premature 「どのサービスで公開
 *    しますか」. A bare verb-plus-noun regex hit is not strong enough evidence to
 *    outrank the model; an extracted entity is.
 *
 *    ⚠️ `hasPostAcquisitionSignal` (`routing/ruleBasedIntent.ts`) is the second
 *    admissible form of that evidence, added for
 *    「ドメインを取得したが公開のために何をすれば良い」. It is not a bare verb-plus-noun
 *    hit: it requires the word 「ドメイン」, a PAST-tense acquisition
 *    (「取得した」/「買った」, each excluding the volitional 「取得したい」), and a
 *    "what next" question, all in the same sentence. A 0.6B model reliably
 *    reads that as 「取得したい」 and proposes ドメイン検索 - sending the user off to
 *    buy the domain they have just told us they already own. Unlike the
 *    「パン屋のサイトを作りたい」 case there is no defensible reading in which
 *    ドメイン検索 is right, because the sentence itself rules it out. The
 *    contradiction test (condition 2) still has to pass on top of this, so a
 *    model that proposes a screen the rule-based intent DOES allow is left
 *    alone.
 *
 * When it does fire, the model's prose goes with it. Keeping the reply while
 * swapping the card underneath would leave the two describing different things
 * - the exact inconsistency this fixes. A turn we have decided the model
 * misread is a turn whose wording is suspect too, so the whole answer comes
 * from the Playbook, with the same honest `RULE_BASED_FALLBACK_PREFIX` the
 * fallback path uses.
 */
function modelRouteContradictsRuleBasedIntent(decisionIntent: IntentId, navigation: NavigationSuggestion | null, userInput: string): boolean {
  if (navigation === null) return false
  const guess = classifyIntent(userInput)
  if (!guess || guess.intent === decisionIntent) return false
  if (Object.keys(guess.slots).length === 0 && !hasPostAcquisitionSignal(userInput)) return false
  const guessPlaybook = findPlaybook(guess.intent)
  if (!guessPlaybook) return false
  return !guessPlaybook.allowedRoutes.includes(navigation.routeId)
}

/**
 * The turn's history for `buildChatRequest`: every OTHER message currently in
 * the conversation, oldest first - excludes the turn's own user message by id
 * so it is never duplicated as both history and the current turn
 * (`buildChatRequest` appends its own `currentUserMessage`).
 */
function historyExcluding(conversation: Conversation | undefined, excludeMessageId: string) {
  return conversation ? conversation.messages.filter((message) => message.id !== excludeMessageId) : []
}

/**
 * §7.5 conversation resolution, shared by `sendMessage` and the deterministic
 * Quick Action path: reuse the active conversation, giving it the auto title
 * when it is still a brand new, empty, untitled one - so the title is set from
 * the first user message, exactly once and never by the LLM.
 *
 * ⚠️ This used to DELETE the untitled conversation and create a replacement
 * carrying the title, because `chatStore` had no rename. Nothing was lost (the
 * conversation had no messages), but `createConversation` appends, so the tab
 * silently jumped to the END of the strip. Invisible with one tab open;
 * with several, typing into the second tab visibly moved it to last position -
 * the reported bug. `renameConversation` keeps the position and the id.
 */
function conversationForNewTurn(normalizedInput: string): Conversation {
  const existing = activeConversationFrom(getChatSnapshot())
  if (!existing) return createConversation(conversationTitleFromInput(normalizedInput))
  if (existing.messages.length === 0 && existing.title === '') {
    renameConversation(existing.id, conversationTitleFromInput(normalizedInput))
    return activeConversationFrom(getChatSnapshot()) ?? existing
  }
  return existing
}

/**
 * Domains already shown, per conversation.
 *
 * Module-level rather than a hook ref because `AssistantModalBody` unmounts
 * every time the modal closes (Radix drops `DialogContent`), and a user who
 * closes the modal and reopens it is still in the same conversation - a ref
 * would forget the page they had already seen and hand them the same three
 * candidates again, which is the bug this whole mechanism exists to fix.
 *
 * Deliberately NOT persisted to sessionStorage: this is a within-session
 * pagination cursor, not conversation content (§7.6 defines what gets stored),
 * and a stale cursor from a previous tab would silently hide candidates.
 * Entries are dropped when their conversation is.
 */
const shownDomainsByConversation = new Map<string, Set<string>>()

/**
 * "Show me the next page" phrasings, mirroring the same family
 * `routing/ruleBasedIntent.ts` recognises. Kept as its own check rather than
 * relying on the intent alone: 「ドメインを探したい」 also classifies as
 * SEARCH_DOMAIN but is a fresh search, not a request for more of the same.
 */
const MORE_CANDIDATES_PATTERN = /(さらに|もっと|他に?の?|別の|次の)/

/** The keywords the last suggestion in each conversation ran with, so a typed "show me more" needs no re-stating. */
const lastSuggestKeywordsByConversation = new Map<string, string[]>()

function shownDomainsForConversation(conversationId: string): Set<string> {
  let shown = shownDomainsByConversation.get(conversationId)
  if (!shown) {
    shown = new Set<string>()
    shownDomainsByConversation.set(conversationId, shown)
  }
  return shown
}

/** Test-only: the module-level map above survives `resetChatStoreForTest()`, which would leak state between tests. */
export function resetShownDomainsForTest(): void {
  shownDomainsByConversation.clear()
  lastSuggestKeywordsByConversation.clear()
}

/**
 * Turns an availability result into the message to write.
 *
 * A `taken` answer always carries the alternatives button: the user asked
 * because they want a domain, and 「取得済みです」 alone ends the conversation on
 * a wall (§35's "never dead-end"). `available` carries none - the Navigation
 * Card to domain search, added by the caller's own Playbook path, is not
 * needed here because the answer IS the thing they asked for.
 */
function askedDomainAnswer(
  asked: AskedDomain,
  result: { state: 'available' | 'taken' | 'unknown'; priceJpy: number | null },
): { content: string; status: 'done'; actions?: AssistantAction[] } {
  if (result.state === 'available') {
    return { content: askedDomainAvailableMessage(asked.domain, result.priceJpy), status: 'done' }
  }
  if (result.state === 'unknown') {
    return { content: askedDomainUnknownMessage(asked.domain), status: 'done' }
  }
  return {
    content: askedDomainTakenMessage(asked.domain),
    status: 'done',
    actions: [
      {
        kind: 'SUGGEST_DOMAINS',
        id: 'suggest-alternatives',
        label: SUGGEST_ALTERNATIVES_ACTION_LABEL,
        // Seeded with the label the user themselves typed - never a model guess.
        payload: { keywords: [asked.label] },
      },
    ],
  }
}

export function useAssistantChat(context: PageContext): UseAssistantChatResult {
  const chatStore = useSyncExternalStore(subscribeChatStore, getChatSnapshot)
  const modelState = useSyncExternalStore(subscribeModelState, getModelSnapshot)
  const [busy, setBusy] = useState(false)

  // Refs mirror the latest render's context/model state/busy flag so the
  // long-lived `processUserTurn` closure (memoized once, see below) always
  // reads current values instead of the ones from whichever render created it.
  const contextRef = useRef(context)
  contextRef.current = context
  const modelStateRef = useRef(modelState)
  modelStateRef.current = modelState

  /** At most one in-flight generation per mounted hook instance (§15.6: one engine). */
  const activeGenerationRef = useRef<{ conversationId: string; controller: AbortController } | null>(null)

  /**
   * v1.4: at most one in-flight SUGGEST_DOMANS request per mounted hook
   * instance, aborted with the same discipline as `activeGenerationRef`
   * (§15.6) - unmount / conversation switch / delete must not leave a stray
   * `fetchSupportedTlds`/`searchDomains` call running against a conversation
   * the user has already left.
   */
  const activeSuggestionRef = useRef<{ conversationId: string; messageId: string; controller: AbortController } | null>(null)
  const [suggestion, setSuggestion] = useState<AssistantSuggestionState>(IDLE_SUGGESTION)

  function setBusyState(next: boolean): void {
    setBusy(next)
  }

  function abortActiveGeneration(reason: string): void {
    const active = activeGenerationRef.current
    if (!active) return
    active.controller.abort(reason)
    getAssistantEngine()?.abort()
  }

  function abortActiveSuggestion(reason: string): void {
    const active = activeSuggestionRef.current
    if (!active) return
    active.controller.abort(reason)
    activeSuggestionRef.current = null
    // Same §15.6 shape as `applyAbortOutcome` below: a user-initiated
    // interruption only changes status, it never fabricates result content.
    updateMessage(active.conversationId, active.messageId, { status: 'failed' })
    setSuggestion((prev) => (prev.messageId === active.messageId ? IDLE_SUGGESTION : prev))
  }

  // Every AbortController this hook ever starts is aborted on unmount - a
  // modal that no longer renders must not keep driving the shared engine.
  useEffect(() => {
    return () => {
      abortActiveGeneration(INTERRUPTED_ABORT_REASON)
      abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- abortActiveGeneration/abortActiveSuggestion only read refs/module-level singletons, safe to capture once.
  }, [])

  function applyAbortOutcome(conversationId: string, messageId: string, reason: unknown): void {
    if (reason === TIMEOUT_ABORT_REASON) {
      updateMessage(conversationId, messageId, { status: 'failed', content: GENERATION_TIMEOUT_MESSAGE })
      return
    }
    // §15.6: a user-initiated interruption (conversation switch, new
    // conversation, delete, unmount) only changes status - whatever text had
    // already streamed in stays visible.
    updateMessage(conversationId, messageId, { status: 'failed' })
  }

  /**
   * §15.1 steps 3-8, shared by the immediate-send path (`sendMessage`, when
   * already READY) and the pending-message processor below (§6.4.1) - both
   * call this once a user turn is ready to actually run the pipeline.
   * `userMessageId` is used only to exclude that message from the history
   * window built for `buildChatRequest` (see `historyExcluding`).
   */
  /**
   * Answers 「a.comは取得できる?」 by actually checking, instead of asking the
   * model to guess. Returns `true` once it has taken responsibility for the
   * turn; `false` means "not this kind of question, carry on".
   *
   * ⚠️ Fires only when BOTH deterministic signals agree: the user's own text
   * names a domain this product can sell (`parseAskedDomain`) AND the
   * rule-based classifier reads the turn as a domain-seeking one. Neither
   * reads a single token the model produced, so the LLM cannot cause a
   * Callable (§8.4 / OWASP LLM06). A message that merely mentions a domain in
   * passing - 「a.com のDNSを変えたい」 classifies as CONNECT_WEBSITE - falls
   * through to the normal pipeline untouched.
   *
   * All three answers are honest: `unknown` is reported as "could not check",
   * never smoothed into a yes or a no (§31).
   */
  /**
   * Synchronous decision: is this turn about one specific domain the user named?
   *
   * ⚠️ The gate is "no OTHER intent claims this message", NOT "the verb is one
   * we recognise". That distinction was a reported bug: 「a.comが欲しい」,
   * 「a.comを取りたい」, 「a.comにしたい」 and a bare 「a.com」 all extracted
   * `a.com` perfectly and then dead-ended at §11.5's apology, because none of
   * their verbs were in `matchSearchDomain`'s vocabulary. A literal, orderable
   * domain name is about as unambiguous as user input gets - gating it behind
   * a hand-maintained verb list put a robust signal behind a fragile one, and
   * every missing word became a dead end.
   *
   * Still deterministic and still model-free: `parseAskedDomain` reads the
   * user's own normalized text and a local price table, `classifyIntent` is
   * pure. A message another intent DOES claim is left alone -
   * 「a.com のDNSを変えたい」 is CONNECT_WEBSITE and never reaches here - so this
   * only takes turns nothing else wanted.
   */
  function parseAskedDomainTurn(userInput: string): AskedDomain | null {
    const asked = parseAskedDomain(userInput)
    if (!asked) return null
    const intent = classifyIntent(userInput)?.intent
    if (intent === undefined) return asked
    return intent === 'SEARCH_DOMAIN' || intent === 'PURCHASE_DOMAIN' ? asked : null
  }

  /**
   * Synchronous decision: is this a typed 「さらに見たい」 for the candidates
   * already on screen?
   *
   * ⚠️ Requires this conversation to have ALREADY shown candidates. "More" is
   * meaningless otherwise, and without that guard a cold 「もっと見たい」 would
   * fire a Callable on a keyword the user never gave. The extra phrase check is
   * needed because 「ドメインを探したい」 also classifies as SEARCH_DOMAIN but is a
   * fresh search, not a request for more of the same.
   */
  function moreCandidatesKeywords(conversationId: string, userInput: string): string[] | null {
    const keywords = lastSuggestKeywordsByConversation.get(conversationId)
    if (!keywords || keywords.length === 0) return null
    if (!MORE_CANDIDATES_PATTERN.test(userInput)) return null
    if (classifyIntent(userInput)?.intent !== 'SEARCH_DOMAIN') return null
    return keywords
  }

  /**
   * Checks the domain the user named and writes the answer. All three outcomes
   * are honest: `unknown` is reported as "could not check", never smoothed into
   * a yes or a no (§31).
   */
  const runAskedDomainCheck = useCallback(async (conversationId: string, asked: AskedDomain) => {
    if (activeSuggestionRef.current) abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    const placeholder = appendMessage(conversationId, {
      role: 'assistant',
      content: DOMAIN_CANDIDATES_LOADING_MESSAGE,
      status: 'streaming',
    })
    const controller = new AbortController()
    activeSuggestionRef.current = { conversationId, messageId: placeholder.id, controller }
    setBusyState(true)
    try {
      const result = await checkAskedDomainImpl(asked, {}, controller.signal)
      if (controller.signal.aborted) return
      updateMessage(conversationId, placeholder.id, askedDomainAnswer(asked, result))
    } finally {
      if (activeSuggestionRef.current?.controller === controller) activeSuggestionRef.current = null
      setBusyState(false)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refs and module-level singletons only; memoized once (see the module doc).
  }, [])

  const processUserTurn = useCallback(async (conversationId: string, userMessageId: string, userInput: string) => {
    emitAssistantEvent({ type: 'message_sent' })

    const verdict = detectScope(userInput)
    const fixedReply = fixedReplyForScope(verdict)
    if (fixedReply !== null) {
      // §12.4: SUSPICIOUS/OUT_OF_SCOPE never touches the engine, even while
      // the model is still loading.
      appendMessage(conversationId, { role: 'assistant', content: fixedReply, status: 'done' })
      const eventType = eventTypeForScope(verdict)
      if (eventType) emitAssistantEvent({ type: eventType })
      return
    }

    // §8.4 / FR-17, deterministic branches: answer the question the user
    // actually asked instead of paraphrasing it at a 0.6B model.
    //
    // ⚠️ Both triggers are decided SYNCHRONOUSLY, from the user's own
    // normalized text only - `parseAskedDomain` and `classifyIntent`, both pure
    // and app-side. The model is not consulted and cannot reach either path,
    // which is the property §8.4 cites OWASP LLM06 for: a Callable never fires
    // on the LLM's say-so. What HAS changed from the original reading is that a
    // typed message now counts as the user action alongside a button click -
    // the user's own words are as explicit an instruction as a click
    // (§0.4.4 決定64).
    //
    // Deciding synchronously also matters mechanically: an `await` here would
    // delay the assistant placeholder on EVERY ordinary turn, which callers
    // (and `FR-01`'s own test) rely on appearing in the same tick.
    const asked = parseAskedDomainTurn(userInput)
    if (asked) {
      void runAskedDomainCheck(conversationId, asked)
      return
    }
    const moreKeywords = moreCandidatesKeywords(conversationId, userInput)
    if (moreKeywords) {
      void runSuggestDomains({ keywords: moreKeywords })
      return
    }

    if (modelStateRef.current.status !== 'READY') return // Defensive: callers only reach here once READY.
    const engine = getAssistantEngine()
    if (!engine) return // Defensive: an engine instance always exists by READY.

    // §15.6: starting a new generation always supersedes whatever this hook
    // instance was already running (a single engine cannot serve two turns
    // at once) - the explicit aborts in selectConversation/newConversation/
    // deleteConversation/deleteAllConversations below cover the "no next turn
    // follows" case; this covers every case that does start one.
    if (activeGenerationRef.current) abortActiveGeneration(INTERRUPTED_ABORT_REASON)

    const conversation = getChatSnapshot().conversations.find((entry) => entry.id === conversationId)
    const history = historyExcluding(conversation, userMessageId)
    const assistantMessage = appendMessage(conversationId, { role: 'assistant', content: '', status: 'streaming' })

    const controller = new AbortController()
    activeGenerationRef.current = { conversationId, controller }
    setBusyState(true)

    const parser = createStreamingParser()
    let body = ''
    const timeoutId = setTimeout(
      () => controller.abort(TIMEOUT_ABORT_REASON),
      ASSISTANT_CONFIG.limits.generationTimeoutMs,
    )

    try {
      // v1.4 design contract §2.1: the conversation's GoalState as of BEFORE
      // this turn - i.e. everything already learned from prior turns - is
      // what the model should see summarised in `CONTEXT:`. `conversation`
      // was already fetched above, so this is the same snapshot `history`
      // was built from.
      const request = buildChatRequest({ userInput, context: contextRef.current, history, goal: conversation?.goal ?? null })
      await engine.chat(
        request,
        (delta) => {
          const { bodyDelta } = parser.push(delta)
          if (bodyDelta === '') return
          body += bodyDelta
          // §12.7/§33.2/FR-16: the body is rendered as it streams, so EVERY
          // output-guard layer has to run here, not only at the end of the
          // turn - see `sanitizeStreamingBody`'s own doc for the leak that
          // running just one of them allowed.
          updateMessage(conversationId, assistantMessage.id, { content: sanitizeStreamingBody(body) })
        },
        controller.signal,
      )

      if (controller.signal.aborted) {
        applyAbortOutcome(conversationId, assistantMessage.id, controller.signal.reason)
        return
      }

      const parsed = parser.finish()
      if (!parsed.ok) {
        applyFallback(conversationId, assistantMessage.id, userInput, contextRef.current, parsed.reason, parser.raw())
        return
      }

      const guarded = guardDecision(toDecisionCandidate(parsed.value), contextRef.current)
      if (!guarded.ok) {
        applyFallback(conversationId, assistantMessage.id, userInput, contextRef.current, guarded.reason, parser.raw())
        return
      }

      const { decision, navigation } = guarded.value

      // §11.4 can only check that the route is legal for the intent the model
      // chose - never that the intent matched the request. Cross-check the
      // destination against the deterministic reading of the user's own words
      // before writing anything; see `modelRouteContradictsRuleBasedIntent`.
      if (modelRouteContradictsRuleBasedIntent(decision.intent, navigation, userInput)) {
        logValidationFailure(`route_contradicts_rule_based_intent (model=${decision.intent}, route=${navigation?.routeId})`, parser.raw())
        if (applyRuleBasedGuess(conversationId, assistantMessage.id, userInput, contextRef.current)) return
      }

      // v1.4 design contract §2.1/§29.2 + §3/§30: merge this turn's validated
      // intent/slots into the conversation's GoalState, then derive Quick
      // Actions from the now-updated goal. `decision.slots` has already been
      // through §11.4's full validation pipeline by this point (schema ->
      // Playbook slot filtering), so nothing unvalidated ever reaches
      // `GoalState` (§29.4), and the actions are decided by the app, never
      // chosen by the LLM - see `actions.ts`'s module doc.
      const update = applyGuardedDecision(conversationId, guarded.value, null)

      // "Never dead-end": an `UNKNOWN` decision with zero derived actions
      // (deriveActions always returns [] for UNKNOWN/OUT_OF_SCOPE) is exactly
      // as unhelpful to the user as a rejected decision - most commonly a
      // `headerless` parse (`outputParser.ts`) of a plain-prose reply that
      // never named an Intent at all. Route it through the same fallback so
      // it at least gets `routing/ruleBasedIntent.ts`'s guess at a next step.
      if (decision.intent === 'UNKNOWN' && update.actions === undefined) {
        applyFallback(conversationId, assistantMessage.id, userInput, contextRef.current, 'unknown_no_actions', parser.raw())
        return
      }

      updateMessage(conversationId, assistantMessage.id, update)
      if (navigation) emitAssistantEvent({ type: 'navigation_suggested', routeId: navigation.routeId, intent: decision.intent })
      if (decision.needsClarification) emitAssistantEvent({ type: 'clarification_asked', intent: decision.intent })
    } catch {
      if (controller.signal.aborted) {
        applyAbortOutcome(conversationId, assistantMessage.id, controller.signal.reason)
      } else {
        // §16: WebLLM crashed / the inference call itself rejected.
        updateMessage(conversationId, assistantMessage.id, { status: 'failed', content: MODEL_LOAD_FAILED_MESSAGE })
      }
    } finally {
      clearTimeout(timeoutId)
      if (activeGenerationRef.current?.controller === controller) activeGenerationRef.current = null
      setBusyState(false)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- every dependency is a ref or a module-level singleton; memoized once on purpose (see the module doc).
  }, [])

  const sendMessage = useCallback(
    (rawInput: string) => {
      const normalized = normalizeUserInput(rawInput)
      if (normalized === '') return

      // §7.5: the auto title is set once, from the conversation's first user
      // message, never by the LLM - see `conversationForNewTurn`.
      const conversation = conversationForNewTurn(normalized)

      const ready = modelStateRef.current.status === 'READY'
      // §6.4.1: while the model is not READY, the user turn itself is stored
      // `pending` - not a placeholder assistant message - and the
      // pending-message effect below runs §15.1 steps 3-8 for it once READY.
      const userMessage = appendMessage(conversation.id, {
        role: 'user',
        content: normalized,
        status: ready ? 'done' : 'pending',
      })
      if (!ready) return

      void processUserTurn(conversation.id, userMessage.id, normalized)
    },
    [processUserTurn],
  )

  // §6.4.1/FR-11: whenever the model is READY and no generation is already
  // running, take the oldest pending message across every conversation (not
  // just the active one) and run the pipeline for it. Re-evaluating on every
  // store/model-state change is intentional and cheap: `nextPendingMessage`
  // plus the `busy` guard make every no-op re-entry instant.
  useEffect(() => {
    if (modelState.status !== 'READY' || busy) return
    const pending = nextPendingMessage(chatStore)
    if (!pending) return
    updateMessage(pending.conversationId, pending.message.id, { status: 'done' })
    void processUserTurn(pending.conversationId, pending.message.id, pending.message.content)
  }, [modelState.status, busy, chatStore, processUserTurn])

  /**
   * §15.6: switching away from the conversation that is actively generating
   * aborts it - switching to/between conversations that are not generating
   * never touches the engine.
   */
  const selectConversation = useCallback((id: string) => {
    const activeId = getChatSnapshot().activeConversationId
    const active = activeGenerationRef.current
    if (active && active.conversationId === activeId && id !== activeId) abortActiveGeneration(INTERRUPTED_ABORT_REASON)
    const activeSug = activeSuggestionRef.current
    if (activeSug && activeSug.conversationId === activeId && id !== activeId) abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    storeSelectConversation(id)
  }, [])

  const newConversation = useCallback(() => {
    const activeId = getChatSnapshot().activeConversationId
    const active = activeGenerationRef.current
    if (active && active.conversationId === activeId) abortActiveGeneration(INTERRUPTED_ABORT_REASON)
    const activeSug = activeSuggestionRef.current
    if (activeSug && activeSug.conversationId === activeId) abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    createConversation()
  }, [])

  const deleteConversation = useCallback((id: string) => {
    const active = activeGenerationRef.current
    if (active && active.conversationId === id) abortActiveGeneration(INTERRUPTED_ABORT_REASON)
    const activeSug = activeSuggestionRef.current
    if (activeSug && activeSug.conversationId === id) abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    shownDomainsByConversation.delete(id)
    lastSuggestKeywordsByConversation.delete(id)
    storeDeleteConversation(id)
  }, [])

  const deleteAllConversations = useCallback(() => {
    abortActiveGeneration(INTERRUPTED_ABORT_REASON)
    abortActiveSuggestion(INTERRUPTED_ABORT_REASON)
    shownDomainsByConversation.clear()
    lastSuggestKeywordsByConversation.clear()
    storeDeleteAllConversations()
  }, [])

  const retryModelLoad = useCallback(() => {
    void storeRetryModelLoad()
  }, [])

  const grantConsent = useCallback(() => {
    void grantDownloadConsent()
  }, [])

  /**
   * v1.4 design contract §4.2/§8.4: runs the SUGGEST_DOMANS click flow.
   * `suggestDomainsImpl` (test seam aside) is `suggestDomains` from
   * `suggest/domainSuggestion.ts`, and this is the ONLY call site for it in
   * the entire feature - see the module doc at the top of this file and the
   * FR-17 test in `useAssistantChat.test.tsx`.
   *
   * Mirrors `processUserTurn`'s "append a placeholder immediately, update it
   * once the async work resolves" shape: the placeholder starts
   * `status: 'streaming'` so `MessageList`'s existing streaming-hint UI
   * doubles as the loading indicator here, with no extra UI-side branching.
   */
  const runSuggestDomains = useCallback(async (payload: SuggestDomainsPayload) => {
    const conversationId = getChatSnapshot().activeConversationId
    if (!conversationId) return

    if (activeSuggestionRef.current) abortActiveSuggestion(INTERRUPTED_ABORT_REASON)

    const placeholder = appendMessage(conversationId, {
      role: 'assistant',
      content: DOMAIN_CANDIDATES_LOADING_MESSAGE,
      status: 'streaming',
    })
    const controller = new AbortController()
    activeSuggestionRef.current = { conversationId, messageId: placeholder.id, controller }
    setSuggestion({ status: 'loading', result: null, messageId: placeholder.id })

    try {
      // Everything this conversation has already put on screen, so a second
      // 「別の候補を見る」 never returns the same domains - see
      // `shownDomainsForConversation`.
      const alreadyShown = shownDomainsForConversation(conversationId)
      // Remembered so a typed 「さらに見たい」 can fetch the next page without the
      // user having to name the keyword again - see `handleMoreCandidatesTurn`.
      if (payload.keywords.length > 0) lastSuggestKeywordsByConversation.set(conversationId, [...payload.keywords])
      const result = await suggestDomainsImpl(payload.keywords, { exclude: [...alreadyShown] }, controller.signal)
      if (controller.signal.aborted) return

      const candidates = [...result.ruleCandidates, ...result.aiCandidates]
      const isFirstPage = alreadyShown.size === 0
      const content = result.degraded
        ? SUGGEST_DOMAINS_FAILED_MESSAGE
        : candidates.length > 0
          ? DOMAIN_CANDIDATES_READY_MESSAGE
          : // "nothing at all" and "nothing MORE" are different statements, and
            // saying the first after the user has already seen candidates would
            // be false.
            isFirstPage
            ? DOMAIN_CANDIDATES_EMPTY_MESSAGE
            : DOMAIN_CANDIDATES_NO_MORE_MESSAGE

      for (const candidate of candidates) alreadyShown.add(candidate.domain)

      updateMessage(conversationId, placeholder.id, {
        content,
        status: 'done',
        // §30: the app offers the next step itself rather than waiting to be
        // asked. The reported failure was 「さらに見たい」 typed after a candidate
        // list, which dead-ended - a button removes the need to guess that
        // typing works at all. Offered only while there is a next page to
        // fetch and a keyword to fetch it with.
        ...(candidates.length > 0 && payload.keywords.length > 0
          ? {
              actions: [
                {
                  kind: 'SUGGEST_DOMAINS' as const,
                  id: 'suggest-more-domains',
                  label: SUGGEST_MORE_DOMAINS_ACTION_LABEL,
                  payload: { keywords: payload.keywords },
                },
              ],
            }
          : {}),
      })
      // FR-18: `degraded` -> 'error', so no downstream reader mistakes this
      // for a completed, trustworthy candidate list.
      setSuggestion({ status: result.degraded ? 'error' : 'done', result, messageId: placeholder.id })
    } catch {
      if (controller.signal.aborted) return
      // `suggestDomains` itself never throws (it turns every failure into
      // `degraded: true`, see its module doc) - this branch only exists for
      // an injected test double / future defensiveness, and follows the same
      // "honest failure, no fabricated availability" rule.
      updateMessage(conversationId, placeholder.id, { content: SUGGEST_DOMAINS_FAILED_MESSAGE, status: 'done' })
      setSuggestion({ status: 'error', result: null, messageId: placeholder.id })
    } finally {
      if (activeSuggestionRef.current?.controller === controller) activeSuggestionRef.current = null
    }
  }, [])

  /**
   * v1.7: answers a `SET_SLOT` click whose `payload.intent` the app already
   * knows, WITHOUT a model round-trip. Returns `false` when the payload carries
   * no usable intent, meaning the caller should fall back to the normal
   * `sendMessage` path; `true` once this function has taken responsibility for
   * the turn (including when the guard rejects, so the caller never
   * double-appends the user message).
   *
   * Why this exists: `runAction` used to answer EVERY `SET_SLOT` click by
   * re-sending `action.label` as free text, so a button the app had written -
   * from a Playbook whose intent it already held - was handed back to a 0.6B
   * model to re-derive. The browser report this fixes shows the failure that
   * follows: the assistant offered 「Webサイトを公開したい」, the click was routed
   * through the model, the model's output failed to parse, and the user was
   * told 「うまく聞き取れなかったので、簡単な案内でお答えします」 about the assistant's own
   * sentence. There is no reading of the click that needs interpreting: the
   * app authored both the label and the intent.
   *
   * This is a deliberate deviation from spec §30.4's "SET_SLOT re-enters the
   * guarded pipeline exactly like typed text". Only the *classification* step
   * is skipped, and only when the app already performed it. Every guard §11.4
   * and §12.4 define still runs: the Input Guard (`normalizeUserInput`), the
   * Scope Detector, and the same `guardDecision` call the model path uses -
   * schema validation, Playbook slot filtering (an invented `slotKey` cannot
   * set anything, see the `requiredSlots` check below), route resolution
   * against `allowedRoutes`, the confidence floor, and reply sanitization.
   *
   * The Scope Detector runs even though the label is app-authored, because
   * `ChatMessage.actions` is persisted to `sessionStorage` and rehydrated with
   * shape validation only (`store/chatStore.ts`'s `isValidAssistantAction`
   * deliberately does not re-derive payload contents). A stored action is
   * therefore not provably app-authored at the point it is clicked, and
   * §12.4's "SUSPICIOUS/OUT_OF_SCOPE never gets a Playbook answer" must hold
   * for every path into the pipeline, not only the typed one.
   */
  const runResolvedSetSlot = useCallback((label: string, payload: SetSlotPayload): boolean => {
    const intent = payload.intent
    if (intent === undefined) return false
    const playbook = findPlaybook(intent)
    if (!playbook) return false

    const normalized = normalizeUserInput(label)
    if (normalized === '') return false

    // Hand a SUSPICIOUS/OUT_OF_SCOPE label back to `sendMessage`, which owns
    // §12.4's fixed replies and their events - this function must never answer
    // one from a Playbook.
    if (fixedReplyForScope(detectScope(normalized)) !== null) return false

    emitAssistantEvent({ type: 'message_sent' })

    // §15.6: this turn supersedes any generation still streaming, for the same
    // reason `processUserTurn` aborts one - the answer about to be appended
    // makes the in-flight one stale.
    if (activeGenerationRef.current) abortActiveGeneration(INTERRUPTED_ABORT_REASON)

    const conversation = conversationForNewTurn(normalized)
    appendMessage(conversation.id, { role: 'user', content: normalized, status: 'done' })

    // Everything already learned this conversation (§29.2), plus the one value
    // this click sets. `payload.slotKey` is only honoured when the Playbook
    // actually declares it, so a placeholder key (`'fallback'`, `'purpose'`)
    // sets nothing and simply leaves the required slot unfilled - which is
    // exactly right: clicking 「Webサイトを公開したい」 should produce the provider
    // question, not skip it.
    const knownSlots = getChatSnapshot().conversations.find((entry) => entry.id === conversation.id)?.goal?.slots ?? {}
    const slots: Record<string, string> = { ...knownSlots }
    if (playbook.requiredSlots.some((slot) => slot.key === payload.slotKey)) {
      slots[payload.slotKey] = payload.value
    }

    const candidate = buildResolvedCandidate(intent, slots)
    const guarded = candidate ? guardDecision(candidate, contextRef.current) : null
    if (!guarded?.ok) {
      // Cannot happen for an app-authored payload (the reply is a Playbook
      // constant and the slots are Playbook values), but the turn must still
      // end somewhere other than silence - §35's "never dead-end".
      emitAssistantEvent({ type: 'output_validation_failed' })
      appendMessage(conversation.id, {
        role: 'assistant',
        content: DECISION_VALIDATION_FAILED_MESSAGE,
        status: 'done',
        actions: fallbackActions(normalized),
      })
      return true
    }

    const update = applyGuardedDecision(conversation.id, guarded.value, null)
    appendMessage(conversation.id, { role: 'assistant', ...update })
    if (update.navigation) {
      emitAssistantEvent({ type: 'navigation_suggested', routeId: update.navigation.routeId, intent })
    }
    if (guarded.value.decision.needsClarification) emitAssistantEvent({ type: 'clarification_asked', intent })
    return true
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- every dependency is a ref or a module-level singleton; memoized once on purpose (see the module doc).
  }, [])

  /**
   * v1.4 design contract §3/§30.4: runs one app-derived Quick Action. This is
   * the ONLY place `AssistantAction`s are ever acted on - the LLM never
   * chooses or triggers one itself.
   */
  const runAction = useCallback(
    (action: AssistantAction) => {
      switch (action.kind) {
        case 'SET_SLOT': {
          // v1.7: a button the app itself authored, whose `payload.intent`
          // records the Playbook it already resolves to, is answered from that
          // Playbook - see `runResolvedSetSlot`. Every other SET_SLOT button
          // (today: `purposeShortcutActions()`'s purpose words, which are
          // genuinely free text the model has to interpret) still goes through
          // the exact same guarded pipeline as typed text (§30.4: Input Guard
          // -> Scope Detector -> engine -> guardDecision), never bypassing it
          // by writing the value into the conversation directly.
          const payload = action.payload as SetSlotPayload
          if (runResolvedSetSlot(action.label, payload)) return
          sendMessage(action.label)
          return
        }
        case 'SUGGEST_DOMAINS': {
          const payload = action.payload as SuggestDomainsPayload
          // "Never dead-end": a SUGGEST_DOMAINS button can now exist with no
          // keyword at all (see `actions.ts`'s `suggestDomainsActions`) -
          // calling `suggestDomains([])` would silently produce nothing, so
          // ask the user for a keyword instead of running the search.
          if (payload.keywords.length === 0) {
            const conversationId = getChatSnapshot().activeConversationId
            if (conversationId) {
              // v1.5 "ask what kind of site": asks what the site is FOR (with
              // examples) rather than a bare "give me a keyword", and attaches
              // one-click purpose buttons - see `SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE`
              // and `purposeShortcutActions()`'s own module docs.
              appendMessage(conversationId, {
                role: 'assistant',
                content: SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE,
                status: 'done',
                actions: purposeShortcutActions(),
              })
            }
            return
          }
          void runSuggestDomains(payload)
          return
        }
        case 'START_WALKTHROUGH': {
          // §34/W2: the walkthrough only ever starts from this explicit user
          // click - never automatically when an intent is recognised, so
          // simply asking a question never hijacks the modal with a checklist.
          // The template id came from `templateForIntent`, an intent->template
          // table lookup in `actions.ts`; the LLM never names a template (§8.2).
          const payload = action.payload as StartWalkthroughPayload
          const conversationId = getChatSnapshot().activeConversationId
          if (conversationId) startWalkthrough(conversationId, payload.templateId, Date.now())
          return
        }
        case 'OPEN_DOC':
        case 'RUN_WEB_SEARCH':
          // Rendered as real `<a href>` links by QuickActions/DocSourceCard/
          // SearchQueryCard (design contract §5.1: the only place an
          // external href may be rendered) - the browser's own click on
          // that anchor is the entire interaction. No `AssistantEventType`
          // member fits "a Quick Action link was opened" (see the wave
          // report), so nothing is emitted here for these two kinds.
          return
      }
    },
    [sendMessage, runSuggestDomains, runResolvedSetSlot],
  )

  return {
    store: chatStore,
    activeConversation: activeConversationFrom(chatStore) ?? EMPTY_CONVERSATION,
    modelState,
    busy,
    sendMessage,
    newConversation,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    retryModelLoad,
    grantConsent,
    runAction,
    suggestion,
  }
}
