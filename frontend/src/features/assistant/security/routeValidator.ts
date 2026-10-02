/**
 * §11.4 + §11.6 (FR-04/FR-05) validation pipeline: `validateDecision ->
 * findPlaybook -> slot filtering -> route resolution -> confidence floor ->
 * reply sanitization -> Navigation Card gating`. This is the last layer
 * before a decision reaches the UI, and it never reads a URL, path, or DNS
 * value out of the model's output (§8.2) - the only navigational field the
 * model may produce is `routeId`, and even that is only ever compared
 * against static Manifest/Playbook data, never used to build a path or
 * interpreted from `decision.reply`'s free text.
 */
import { ASSISTANT_CONFIG } from '../config/assistantConfig'
import { validateDecision } from '../decisionSchema'
import { resolveNavigation } from '../routing/manifestResolver'
import { findPlaybook, isIntentId, resolveRouteForSlots, validateLabelSlotValue } from '../routing/playbooks'
import type { AssistantPlaybook, AssistantSlot } from '../routing/playbooks'
import { isEnabledRouteId } from '../routing/routeManifest'
import type { RouteId } from '../routing/routeManifest'
import type { AssistantDecision, NavigationSuggestion, PageContext } from '../types'
import { sanitizeReply } from './outputGuard'

export type DecisionRejectionReason =
  | 'schema_invalid'
  | 'unknown_intent'
  | 'low_confidence'
  | 'empty_reply'
  /** v1.4 §33: the reply consisted only of code, which the Output Guard removed. */
  | 'code_only_reply'
  /** v1.5 §12.7: the reply consisted only of echoed System Prompt / CONTEXT values. */
  | 'context_echo_only_reply'

export interface GuardedDecision {
  /** Sanitized: `slots` filtered, `routeId` possibly nulled, `reply` sanitized. */
  decision: AssistantDecision
  /** `null` means "show the reply only" - no Navigation Card. */
  navigation: NavigationSuggestion | null
  masked: boolean
}

/**
 * v1.4 §10.1: a slot is accepted either as an `enum` (the value must be one of
 * `allowedValues`) or as a `label` (`allowedValues` is empty by design; the raw
 * value is a comma-separated list of domain labels validated by
 * `validateLabelSlotValue`, which reuses the search page's own validators).
 * `kind` absent ⇒ `'enum'`, so every pre-v1.4 slot behaves exactly as before.
 */
function acceptedSlotValue(slot: AssistantSlot, rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined
  if (slot.kind === 'label') {
    const labels = validateLabelSlotValue(rawValue)
    // Store the normalised, re-joined form - never the model's raw text.
    return labels.length > 0 ? labels.join(',') : undefined
  }
  return slot.allowedValues.includes(rawValue) ? rawValue : undefined
}

/**
 * Every **required** `requiredSlots` entry has an accepted value.
 *
 * v1.4 §10.1: a slot marked `optional: true` never blocks satisfaction. That
 * distinction is what keeps 「ドメインを取得したい」 working — `SEARCH_DOMAIN`'s
 * `keyword` slot is optional, so the DOMAIN_SEARCH Navigation Card still
 * appears when the user has not named a keyword yet; the keyword only ENABLES
 * the extra `SUGGEST_DOMAINS` quick action (§30) when it happens to be filled.
 * Treating it as required suppressed the card entirely — a regression caught by
 * `useAssistantChat.test.tsx`.
 */
export function isPlaybookSatisfied(playbook: AssistantPlaybook, slots: Readonly<Record<string, string>>): boolean {
  return playbook.requiredSlots.every((slot) => {
    if (slot.optional === true) return true
    return acceptedSlotValue(slot, slots[slot.key]) !== undefined
  })
}

/**
 * §11.4: "slots の未知キー・allowedValues 外の値は破棄する". Keeps only keys
 * the Playbook declares as `requiredSlots`, and only when the value passes that
 * slot's own acceptance rule (`allowedValues` for an enum slot, the label
 * validator for a `kind: 'label'` slot). Everything else - including any key
 * the model invented - is dropped silently, never surfaced as an error.
 *
 * Optional slots are filtered exactly like required ones: being optional only
 * affects whether an ABSENT value blocks satisfaction, never whether a PRESENT
 * value is allowed through unvalidated.
 */
function filterSlots(playbook: AssistantPlaybook, slots: Readonly<Record<string, string>>): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const slot of playbook.requiredSlots) {
    const accepted = acceptedSlotValue(slot, slots[slot.key])
    if (accepted !== undefined) {
      filtered[slot.key] = accepted
    }
  }
  return filtered
}

/**
 * §11.4/§10.1: once `requiredSlots` are satisfied, the app-side slot
 * resolution (`resolveRouteForSlots`, §10.1) intentionally *overrides* the
 * model's own `routeId` - e.g. `provider=cloudflare` always resolves to
 * DNS_NAMESERVER even if the model said DNS_RECORDS, because which route a
 * slot value implies is app-defined policy (`playbooks.ts`), not something
 * the model's free text gets to decide. Only when the slots are not (yet)
 * satisfied does the model's own `routeId` get a chance, and even then only
 * when it is one of the Playbook's `allowedRoutes`; any other value is
 * always dropped to `null` (§11.4).
 */
function resolveRouteId(
  playbook: AssistantPlaybook,
  slots: Readonly<Record<string, string>>,
  modelRouteId: RouteId | null,
): RouteId | null {
  if (isPlaybookSatisfied(playbook, slots)) {
    const resolved = resolveRouteForSlots(playbook, slots)
    if (resolved !== null) return resolved
  }
  if (modelRouteId !== null && playbook.allowedRoutes.includes(modelRouteId)) {
    return modelRouteId
  }
  return null
}

/** Uppercases and normalises a model-written enum token: `" dns_records."` -> `"DNS_RECORDS"`. */
function normalizeEnumToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .replace(/^[`'"*\s]+|[`'"*.,。\s]+$/g, '')
    .replace(/[\s-]+/g, '_')
    .toUpperCase()
  return normalized === '' ? null : normalized
}

/**
 * §11.4 says an out-of-allowlist `routeId` must be "dropped to null so only the
 * reply is shown" - but `decisionSchema`'s `z.enum(ALLOWED_ROUTE_IDS)` rejects
 * the WHOLE decision instead, so one hallucinated route token used to throw away
 * an otherwise perfectly good answer and show §11.5's fixed message. Same for a
 * hallucinated intent, for which §10.2 already defines the right landing place:
 * `UNKNOWN` ("判断不能 → 再質問"), whose Playbook allows no routes at all.
 *
 * Normalising here, before validation, makes the schema behave the way §11.4
 * describes. It cannot widen what the model may decide: an unrecognised value is
 * only ever replaced by `null` or `UNKNOWN`, never by a real route.
 */
function normalizeDecisionCandidate(candidate: unknown): unknown {
  if (typeof candidate !== 'object' || candidate === null) return candidate
  const source = candidate as Record<string, unknown>

  const intentToken = normalizeEnumToken(source.intent)
  const intent = intentToken !== null && isIntentId(intentToken) ? intentToken : 'UNKNOWN'

  const routeToken = normalizeEnumToken(source.routeId)
  const routeId = routeToken !== null && isEnabledRouteId(routeToken) ? routeToken : null

  return { ...source, intent, routeId }
}

export function guardDecision(
  candidate: unknown,
  context: PageContext,
): { ok: true; value: GuardedDecision } | { ok: false; reason: DecisionRejectionReason } {
  // 1. Schema validation (zod). Also where FR-05 first applies: `decisionSchema`
  //    restricts `routeId` to `ALLOWED_ROUTE_IDS` (enabled routes only), so a
  //    disabled or unknown route id (e.g. 'EASY_MODE', 'ORDER_STATUS') already
  //    fails here and never reaches step 4 below.
  const decision = validateDecision(normalizeDecisionCandidate(candidate))
  if (decision === null) return { ok: false, reason: 'schema_invalid' }

  // 2. Playbook lookup.
  const playbook = findPlaybook(decision.intent)
  if (!playbook) return { ok: false, reason: 'unknown_intent' }

  // 3. Slot filtering.
  const slots = filterSlots(playbook, decision.slots)

  // 4. Route resolution - a routeId outside this Playbook's `allowedRoutes`
  //    is always dropped to null here, even though it already passed the
  //    (broader, enabled-routes-only) schema allowlist in step 1.
  const routeId = resolveRouteId(playbook, slots, decision.routeId)

  // 5. Confidence floor.
  if (decision.confidence < ASSISTANT_CONFIG.thresholds.minConfidence) {
    return { ok: false, reason: 'low_confidence' }
  }

  // 6. Reply sanitization. A reply that was nothing BUT a System Prompt echo,
  //    or nothing but code (§33), is left empty by the Output Guard - show
  //    §11.5's fixed message rather than an empty bubble or, worse, a
  //    Navigation Card with no explanation.
  const { text: reply, masked, codeStripped, contextStripped } = sanitizeReply(decision.reply)
  if (reply.trim() === '') {
    // Distinct reasons so the DEV diagnostic can tell WHY a reply vanished:
    // it was all code (§33), all System-Prompt/CONTEXT echo (§12.7), or empty
    // to begin with. Without this they are indistinguishable in the log, which
    // is exactly what made the 「ドメインの選択はfalseです。」 leak slow to trace.
    if (codeStripped) return { ok: false, reason: 'code_only_reply' }
    if (contextStripped) return { ok: false, reason: 'context_echo_only_reply' }
    return { ok: false, reason: 'empty_reply' }
  }
  const sanitizedDecision: AssistantDecision = { ...decision, slots, routeId, reply }

  // 7. Navigation Card gating - every condition must hold.
  const cardEligible =
    !decision.needsClarification &&
    isPlaybookSatisfied(playbook, slots) &&
    routeId !== null &&
    decision.confidence >= ASSISTANT_CONFIG.thresholds.minConfidence

  // 8. Resolve to a path, degrading to no card (never failing the whole
  //    decision) if the route turns out unresolvable (disabled/unknown).
  const navigation = cardEligible && routeId !== null ? resolveNavigation(routeId, context) : null

  return { ok: true, value: { decision: sanitizedDecision, navigation, masked } }
}
