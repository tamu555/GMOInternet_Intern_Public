/**
 * Derives the app-rendered Quick Action buttons for an assistant message
 * (design contract §3). Actions are decided entirely by the app from
 * `decision`/`goal`/`playbook` - the LLM never chooses an action, and this
 * module has no React/DOM/`Date.now()` dependency so it stays a pure,
 * fully-unit-testable function.
 */
import {
  FALLBACK_SHORTCUT_EXPLAIN_TERMS_LABEL,
  FALLBACK_SHORTCUT_PUBLISH_WEBSITE_LABEL,
  FALLBACK_SHORTCUT_SEARCH_DOMAIN_LABEL,
  FALLBACK_SHORTCUT_SETUP_EMAIL_LABEL,
  NEXT_STEP_CONNECT_WEBSITE_LABEL,
  NEXT_STEP_EXPLAIN_DNS_LABEL,
  NEXT_STEP_SETUP_EMAIL_LABEL,
  NEXT_STEP_VIEW_DOMAIN_LABEL,
  runWebSearchActionLabel,
  SUGGEST_DOMAINS_ACTION_LABEL,
} from './assistantMessages'
import { buildSearchQuery, resolveDocSources, SEARCH_ENGINE_NAME, topicForIntentAndProvider } from './docs/docResolver'
import { startWalkthroughActionLabel, WALKTHROUGH_UNDECIDED_ACTION_LABEL } from './walkthrough/walkthroughMessages'
import { templateForIntent } from './walkthrough/walkthroughTemplates'
import type { WalkthroughId } from './walkthrough/walkthroughTemplates'
import { labelHintsFromText, PURPOSE_SUGGESTIONS } from './routing/domainLabelHints'
import type { AssistantPlaybook, IntentId } from './routing/playbooks'
import { SLOT_VALUE_DISPLAY_NAMES, slotValueDisplayName, validateLabelSlotValue } from './routing/playbooks'
import { classifyIntent } from './routing/ruleBasedIntent'
import type { AssistantDecision, GoalState } from './types'

export { SLOT_VALUE_DISPLAY_NAMES }

export type AssistantActionKind =
  | 'SET_SLOT'
  | 'SUGGEST_DOMAINS'
  | 'OPEN_DOC'
  | 'RUN_WEB_SEARCH'
  /** v1.5 §34: offers to start the guided walkthrough for the understood goal. */
  | 'START_WALKTHROUGH'

export interface SetSlotPayload {
  slotKey: string
  value: string
  /**
   * v1.7: the Intent this button ALREADY resolves to, when the app knew it at
   * the moment the button was built.
   *
   * `useAssistantChat.ts`'s `runAction` used to answer every `SET_SLOT` click by
   * re-sending `action.label` as if the user had typed it, which meant the app
   * threw away an intent it already held and asked a 0.6B model to re-derive
   * it. A real browser report is what this exists to fix: the assistant offered
   * its own 「Webサイトを公開したい」 button, the user clicked it, the model failed
   * to parse, and the reply came back 「うまく聞き取れなかったので…」 - about a
   * sentence the app itself had written. With this field the click is answered
   * deterministically from the Playbook (`resolveGuidance`), so an app-authored
   * button can never be "misheard".
   *
   * Absent for buttons whose meaning genuinely IS free text the model has to
   * interpret - `purposeShortcutActions()`'s purpose words, which exist to be
   * picked up by `labelHintsFromText` on a later turn, not to name an Intent.
   */
  intent?: IntentId
}

export interface SuggestDomainsPayload {
  /**
   * Validated purpose keywords (design contract §4.1), never raw model
   * text - every entry already passed `validateLabelSlotValue`. The first
   * entry seeds the rule-based suggestion engine; all entries become the
   * AI's secondary proposals.
   */
  keywords: string[]
}

export interface OpenDocPayload {
  /** Looked up against `ASSISTANT_DOC_SOURCES` at render time - never a URL itself. */
  docId: string
}

export interface RunWebSearchPayload {
  query: string
}

export interface StartWalkthroughPayload {
  /** Looked up against `WALKTHROUGH_TEMPLATES` - the LLM never names a template. */
  templateId: WalkthroughId
}

export interface AssistantAction {
  kind: AssistantActionKind
  /** Stable id, unique within the message. */
  id: string
  /** Japanese button label, app-built. */
  label: string
  payload: SetSlotPayload | SuggestDomainsPayload | OpenDocPayload | RunWebSearchPayload | StartWalkthroughPayload
}

/**
 * Rule 5: cap per message.
 *
 * ⚠️ Raised from 6 to 8 because 6 could not hold one complete answer set:
 * `CONNECT_WEBSITE` has 7 `provider` values and rule 0 contributes the
 * walkthrough button ahead of them, so the cap silently swallowed the last two
 * options - `cloudflare` and `other` - while the question the assistant had
 * just asked named Cloudflare explicitly. See `capPreservingSlotOptions`: the
 * cap is now a budget for the OTHER rules, never something that can truncate
 * the option list itself.
 */
export const MAX_ACTIONS_PER_MESSAGE = 8

function dedupeAndCap(actions: readonly AssistantAction[], max: number): AssistantAction[] {
  const seen = new Set<string>()
  const result: AssistantAction[] = []
  for (const action of actions) {
    if (seen.has(action.id)) continue
    seen.add(action.id)
    result.push(action)
    if (result.length >= max) break
  }
  return result
}

/**
 * Applies rule 5's cap WITHOUT ever dropping part of the slot option set, and
 * without reordering anything: `actions` keeps its rule 0-4 order, and only
 * unprotected entries are removed, last one first, until the list fits.
 *
 * The buttons for an unfilled slot are the answer set to the question in the
 * very same message; showing some of them is strictly worse than showing none,
 * because a missing option reads as "not available" rather than "there wasn't
 * room". Everything else (the walkthrough offer, SUGGEST_DOMAINS, doc links) is
 * an optional extra, so the cap is spent on those first and the option list is
 * always kept whole - even when that means the message ends up with more than
 * `MAX_ACTIONS_PER_MESSAGE` buttons, which can only happen if a future Playbook
 * declares more than 8 values for one slot.
 */
function capPreservingProtected(
  actions: readonly AssistantAction[],
  protectedIds: ReadonlySet<string>,
  max: number,
): AssistantAction[] {
  const deduped = dedupeAndCap(actions, Number.POSITIVE_INFINITY)
  const result = [...deduped]
  for (let i = result.length - 1; i >= 0 && result.length > max; i--) {
    if (protectedIds.has(result[i]!.id)) continue
    result.splice(i, 1)
  }
  return result
}

/**
 * Rule 1: one SET_SLOT action per `allowedValues` entry of the first
 * unfilled REQUIRED slot. An `optional: true` slot (e.g. `keyword`) never
 * produces a SET_SLOT button while unfilled - there is nothing to prompt
 * the user for; it only feeds rule 2 once it happens to be filled.
 */
function firstUnfilledEnumSlot(
  playbook: AssistantPlaybook | null,
  effectiveSlots: Readonly<Record<string, string>>,
): AssistantPlaybook['requiredSlots'][number] | undefined {
  return playbook?.requiredSlots.find(
    (slot) => (slot.kind ?? 'enum') === 'enum' && slot.optional !== true && effectiveSlots[slot.key] === undefined,
  )
}

function setSlotActions(playbook: AssistantPlaybook | null, effectiveSlots: Readonly<Record<string, string>>): AssistantAction[] {
  if (!playbook) return []
  const unfilledSlot = firstUnfilledEnumSlot(playbook, effectiveSlots)
  if (!unfilledSlot) return []
  return unfilledSlot.allowedValues.map((value) => ({
    kind: 'SET_SLOT' as const,
    id: `set-slot-${unfilledSlot.key}-${value}`,
    label: slotValueDisplayName(value),
    // `intent` carries the Playbook this option set belongs to, so clicking an
    // option the app itself listed is answered from that Playbook rather than
    // sent back through the model - see `SetSlotPayload.intent`.
    payload: { slotKey: unfilledSlot.key, value, intent: playbook.intent },
  }))
}

/**
 * Rule 2 (v1.4 "never dead-end" revision): one SUGGEST_DOMAINS action for
 * every domain-seeking intent - `SEARCH_DOMAIN`/`PURCHASE_DOMAIN` obviously,
 * plus `CONNECT_WEBSITE` (a user who wants to put a site online usually needs
 * a domain for it too). The button is ALWAYS present for these three
 * intents now, never conditional on a keyword already being known - a 0.6B
 * model almost never fills the `keyword` slot from Japanese input, and a
 * button that only sometimes exists is, in practice, a button the user can
 * never rely on (see the team-lead bug report this revision fixes).
 *
 * `payload.keywords` may legitimately be `[]`: `useAssistantChat.ts`'s
 * `runAction` treats that as "ask the user for a keyword" rather than
 * calling `suggestDomains` with nothing (§4.1). Precedence: an already
 * validated Playbook `keyword` slot value wins; failing that,
 * `routing/domainLabelHints.ts`'s deterministic Japanese-noun-dictionary
 * guess against `labelHintText`; failing that, `[]`.
 */
function suggestDomainsActions(
  decision: AssistantDecision,
  effectiveSlots: Readonly<Record<string, string>>,
  labelHintText: string | null,
): AssistantAction[] {
  if (decision.intent !== 'SEARCH_DOMAIN' && decision.intent !== 'PURCHASE_DOMAIN' && decision.intent !== 'CONNECT_WEBSITE') {
    return []
  }

  // ⚠️ CONNECT_WEBSITE only qualifies while the `provider` slot is still
  // unfilled. The rule exists because 「Webサイトを公開したい」, said cold, usually
  // does come with "...and I need a domain for it" - but once the user has
  // named the service they are connecting, they are configuring a domain they
  // already have, not shopping for one. A browser report showed the cost of
  // ignoring that: 「CloudflareでDNSを変えたい」 was answered with a 「ドメイン候補を
  // 探す」 button, offering to go find a domain for someone who was in the middle
  // of changing DNS on theirs.
  if (decision.intent === 'CONNECT_WEBSITE' && effectiveSlots.provider !== undefined) return []

  const rawKeyword = effectiveSlots.keyword
  // Re-validated defensively rather than trusted as-is: this function only
  // knows `effectiveSlots` as a plain string map, not which upstream layer
  // (if any) already ran `validateLabelSlotValue` on it - the payload must
  // never carry unvalidated model text regardless.
  const slotKeywords = rawKeyword !== undefined ? validateLabelSlotValue(rawKeyword) : []
  const keywords = slotKeywords.length > 0 ? slotKeywords : labelHintText !== null ? labelHintsFromText(labelHintText) : []

  return [
    {
      kind: 'SUGGEST_DOMAINS',
      id: 'suggest-domains',
      label: SUGGEST_DOMAINS_ACTION_LABEL,
      payload: { keywords },
    },
  ]
}

/** Rule 3: up to 3 OPEN_DOC actions for a matching doc source; Rule 4: one RUN_WEB_SEARCH action when Rule 3 found nothing but a topic is determinable. */
function docActions(decision: AssistantDecision, effectiveSlots: Readonly<Record<string, string>>): AssistantAction[] {
  const providerId = effectiveSlots.provider ?? null
  // `topicForIntentAndProvider`, not `topicForIntent`: a `mode: 'ns-guide'`
  // provider is connected through a nameserver change, so its documentation
  // lives under `nameserver`, not `custom-domain` (see that function's doc).
  const topic = topicForIntentAndProvider(decision.intent, providerId)
  if (topic === null) return []

  const docSources = resolveDocSources({ providerId, topic }, 3)
  if (docSources.length > 0) {
    return docSources.map((source) => ({
      kind: 'OPEN_DOC' as const,
      id: `open-doc-${source.id}`,
      label: source.title,
      payload: { docId: source.id },
    }))
  }

  const query = buildSearchQuery({ providerId, topic })
  if (query === null) return []
  return [
    {
      kind: 'RUN_WEB_SEARCH',
      id: `run-web-search-${topic}`,
      label: runWebSearchActionLabel(SEARCH_ENGINE_NAME),
      payload: { query },
    },
  ]
}

/**
 * Derives the Quick Actions for one assistant message. Applies rules 1-4 in
 * order (design contract §3), then rule 5 (cap at `MAX_ACTIONS_PER_MESSAGE`,
 * de-duplicated by `id`). An `UNKNOWN`/`OUT_OF_SCOPE` decision - nothing was
 * actually understood, or the request was refused - produces no actions.
 *
 * `labelHintText` (added v1.4 "never dead-end" revision, default `null` so
 * every pre-existing call site keeps compiling unchanged) is fed to rule 2's
 * `labelHintsFromText` fallback when no validated `keyword` slot value exists
 * yet - see `suggestDomainsActions`. v1.5 "ask what kind of site" revision:
 * callers now pass EVERY user message in the conversation so far (not only
 * the first), joined into one string - see `useAssistantChat.ts`'s
 * `labelHintTextOf` - because the purpose word that answers
 * `SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE` (typed freely, or clicked from a
 * `purposeShortcutActions()` button) is a LATER message, not the opening one.
 */
/**
 * v1.5 §34 rule 0: offer to start the guided walkthrough for the understood
 * goal. Placed FIRST because when a goal has a step-by-step procedure, "walk me
 * through it" is the most useful next move — the remaining actions are all
 * single jumps, this one is the whole journey.
 *
 * Only offered when a walkthrough is not already running (`walkthroughActive`),
 * so the button does not sit there restarting something already on screen. The
 * template is chosen by `templateForIntent` — an `intent → template` table
 * lookup — never by the LLM (§8.2).
 */
function startWalkthroughActions(
  decision: AssistantDecision,
  playbook: AssistantPlaybook | null,
  effectiveSlots: Readonly<Record<string, string>>,
  walkthroughActive: boolean,
): AssistantAction[] {
  if (walkthroughActive) return []
  const template = templateForIntent(decision.intent)
  if (!template) return []
  // When this same message is asking the user to pick a required slot value,
  // the walkthrough IS the "I don't know yet" answer to that question - see
  // `WALKTHROUGH_UNDECIDED_ACTION_LABEL`. Label only; the button, the template
  // and the click are unchanged, so it stays first in the list and therefore
  // out of reach of `capPreservingProtected`'s tail-first trimming.
  const undecided = firstUnfilledEnumSlot(playbook, effectiveSlots) !== undefined
  return [
    {
      kind: 'START_WALKTHROUGH',
      id: `start-walkthrough-${template.id}`,
      label: undecided ? WALKTHROUGH_UNDECIDED_ACTION_LABEL : startWalkthroughActionLabel(template.title),
      payload: { templateId: template.id },
    },
  ]
}

/**
 * The four branches `POST_PURCHASE_NEXT_STEPS` exists to offer (see that
 * Playbook's own comment): the hub understands "I have the domain, what now?"
 * but not WHICH goal, and these buttons are how the user names it.
 *
 * Built exactly like `FALLBACK_SHORTCUTS` below - `SET_SLOT` kind carrying the
 * target `intent`, with a placeholder `slotKey` that no Playbook declares, so
 * `useAssistantChat.ts`'s `runResolvedSetSlot` answers the click from the
 * TARGET intent's Playbook (setting no slot) instead of sending the label back
 * through the model. That is what makes 「Webサイトを公開したい」 land on
 * `CONNECT_WEBSITE`'s own provider question - and therefore on its walkthrough
 * offer - rather than on this hub with a slot value filled in.
 */
const NEXT_STEP_BRANCHES: readonly { id: string; label: string; intent: IntentId }[] = [
  { id: 'next-step-connect-website', label: NEXT_STEP_CONNECT_WEBSITE_LABEL, intent: 'CONNECT_WEBSITE' },
  { id: 'next-step-setup-email', label: NEXT_STEP_SETUP_EMAIL_LABEL, intent: 'SETUP_EMAIL' },
  { id: 'next-step-explain-dns', label: NEXT_STEP_EXPLAIN_DNS_LABEL, intent: 'EXPLAIN_DNS' },
  { id: 'next-step-view-domain', label: NEXT_STEP_VIEW_DOMAIN_LABEL, intent: 'VIEW_DOMAIN' },
]

function nextStepBranchActions(decision: AssistantDecision): AssistantAction[] {
  if (decision.intent !== 'POST_PURCHASE_NEXT_STEPS') return []
  return NEXT_STEP_BRANCHES.map((branch) => ({
    kind: 'SET_SLOT' as const,
    id: branch.id,
    label: branch.label,
    payload: { slotKey: 'next-step', value: branch.label, intent: branch.intent },
  }))
}

export function deriveActions(
  decision: AssistantDecision,
  goal: GoalState | null,
  playbook: AssistantPlaybook | null,
  labelHintText: string | null = null,
  walkthroughActive = false,
): AssistantAction[] {
  if (decision.intent === 'UNKNOWN' || decision.intent === 'OUT_OF_SCOPE') return []

  const effectiveSlots: Record<string, string> = { ...(goal?.slots ?? {}), ...decision.slots }

  const slotActions = setSlotActions(playbook, effectiveSlots)
  const actions: AssistantAction[] = [
    ...nextStepBranchActions(decision),
    ...startWalkthroughActions(decision, playbook, effectiveSlots, walkthroughActive),
    ...slotActions,
    ...suggestDomainsActions(decision, effectiveSlots, labelHintText),
    ...docActions(decision, effectiveSlots),
  ]

  return capPreservingProtected(actions, new Set(slotActions.map((action) => action.id)), MAX_ACTIONS_PER_MESSAGE)
}

/**
 * v1.5 "ask what kind of site" revision (design contract §3, browser-ai.md):
 * SET_SLOT-kind purpose shortcut buttons attached to
 * `SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE` (`useAssistantChat.ts`'s `runAction`,
 * the SUGGEST_DOMAINS empty-keywords branch) so a beginner can answer "what
 * is the site for" with one click instead of typing. One button per
 * `routing/domainLabelHints.ts`'s curated `PURPOSE_SUGGESTIONS` entry, its
 * label the Japanese `term` shown on the button. Reuses `SET_SLOT`'s existing
 * "re-send `action.label` through `sendMessage`" behaviour (same precedent as
 * `FALLBACK_SHORTCUTS` above) rather than introducing a new
 * `AssistantActionKind` - the click re-enters the full guarded pipeline
 * exactly like typing the word would, and `labelHintTextOf`
 * (`useAssistantChat.ts`) is what lets `labelHintsFromText` pick the answer
 * back up on a later turn (verified in `domainLabelHints.test.ts` /
 * `useAssistantChat.test.tsx`). `payload.slotKey: 'purpose'` is a placeholder
 * distinct from any real Playbook slot key - only `label` is ever read.
 */
export function purposeShortcutActions(): AssistantAction[] {
  const actions: AssistantAction[] = PURPOSE_SUGGESTIONS.map((suggestion) => ({
    kind: 'SET_SLOT' as const,
    id: `purpose-shortcut-${suggestion.label}`,
    label: suggestion.term,
    payload: { slotKey: 'purpose', value: suggestion.term },
  }))
  return dedupeAndCap(actions, MAX_ACTIONS_PER_MESSAGE)
}

/*
 * "Never dead-end" fallback (see `useAssistantChat.ts`'s `applyFallback`):
 * generic Quick Actions shown alongside §11.5's fixed apology so a turn the
 * model produced nothing usable for still leaves the user with a next step.
 *
 * These shortcut buttons reuse the `SET_SLOT` kind rather than introducing a
 * new `AssistantActionKind` - a new kind would also require teaching
 * `QuickActions.tsx` how to render it, and this module does not own that
 * component. `payload.slotKey: 'fallback'` is a placeholder distinct from any
 * real Playbook slot key; no slot is set by clicking one.
 *
 * ⚠️ Each one now also carries the `intent` it stands for. These four buttons
 * are shown precisely BECAUSE the model just failed on this turn, so re-sending
 * the label as free text and hoping the same model succeeds on the second
 * attempt was the worst possible design: the browser report that prompted this
 * fix shows 「Webサイトを公開したい」 clicked from this very list and answered with
 * 「うまく聞き取れなかったので…」. The label and the intent are written side by side
 * here so a reader can see they agree.
 */
const FALLBACK_SHORTCUTS: readonly { id: string; label: string; intent: IntentId }[] = [
  { id: 'fallback-shortcut-connect-website', label: FALLBACK_SHORTCUT_PUBLISH_WEBSITE_LABEL, intent: 'CONNECT_WEBSITE' },
  { id: 'fallback-shortcut-setup-email', label: FALLBACK_SHORTCUT_SETUP_EMAIL_LABEL, intent: 'SETUP_EMAIL' },
  { id: 'fallback-shortcut-search-domain', label: FALLBACK_SHORTCUT_SEARCH_DOMAIN_LABEL, intent: 'SEARCH_DOMAIN' },
  { id: 'fallback-shortcut-explain-terms', label: FALLBACK_SHORTCUT_EXPLAIN_TERMS_LABEL, intent: 'EXPLAIN_DNS' },
]

/**
 * A `RUN_WEB_SEARCH` action built the same safe way rule 4 (`docActions`)
 * builds one - from a `classifyIntent`-derived topic/provider, never from raw
 * user text (see `docResolver.ts`'s `buildSearchQuery` module doc on why that
 * boundary must never be crossed). `null` when `classifyIntent` found nothing
 * or the topic/provider it found has no search phrase.
 */
function fallbackSearchAction(normalizedInput: string): AssistantAction | null {
  const guess = classifyIntent(normalizedInput)
  if (!guess) return null
  const providerId = guess.slots.provider ?? null
  const topic = topicForIntentAndProvider(guess.intent, providerId)
  const query = buildSearchQuery({ providerId, topic })
  if (query === null) return null
  return {
    kind: 'RUN_WEB_SEARCH',
    id: 'fallback-run-web-search',
    label: runWebSearchActionLabel(SEARCH_ENGINE_NAME),
    payload: { query },
  }
}

/**
 * A small, always-non-empty set of generic Quick Actions for a turn that
 * otherwise produced none: an optional `RUN_WEB_SEARCH` action when
 * `classifyIntent` can infer a topic/provider from `normalizedInput`, plus
 * the fixed shortcut buttons above. Capped at `MAX_ACTIONS_PER_MESSAGE` like
 * every other action list, though today's fixed set (at most 5 entries)
 * never actually reaches it.
 */
export function fallbackActions(normalizedInput: string): AssistantAction[] {
  const searchAction = fallbackSearchAction(normalizedInput)
  const shortcutActions: AssistantAction[] = FALLBACK_SHORTCUTS.map((shortcut) => ({
    kind: 'SET_SLOT',
    id: shortcut.id,
    label: shortcut.label,
    payload: { slotKey: 'fallback', value: shortcut.label, intent: shortcut.intent },
  }))
  const actions = searchAction ? [searchAction, ...shortcutActions] : shortcutActions
  return dedupeAndCap(actions, MAX_ACTIONS_PER_MESSAGE)
}
