/**
 * §8.4 domain-candidate flow (assistant-chat-design.md §4): rule-based
 * candidates are the primary source, AI-proposed keywords are a clearly
 * separated secondary source, and every candidate's availability is
 * verified against the real registry before it is ever described as
 * available. Nothing in this module runs on its own - `suggestDomains` must
 * only ever be invoked from a `SUGGEST_DOMAINS` action's user click handler
 * (D3 / §8.4: LLM proposes keyword(s) -> app validates -> button rendered
 * -> USER CLICKS -> this function runs). It must never be called during
 * model load, on mount, or from any automatic effect: the two Callables it
 * can trigger (`listTlds` via `fetchSupportedTlds`, `searchDomains`) are
 * both read-only, and FR-17 only permits them because they ride the same
 * kind of ordinary user click `DomainSearchPage` already makes
 * unconditionally today - not assistant/model-driven logic.
 *
 * The candidate-generation core stays rule-based (`RuleBasedCandidateSuggester`,
 * reused as-is from `features/domains/suggestionEngine.ts`, untouched). AI's
 * role here is limited to proposing extra keyword strings - never TLD choice,
 * ranking, or availability judgment (docs/project-overview.html:546-553) -
 * and every AI-proposed domain is re-verified through the exact same
 * `verifyCandidates()` path the rule candidates go through, so an unavailable
 * AI idea can never be shown as available.
 */
import {
  fetchSupportedTlds,
  searchDomains,
  type DomainSearchRequest,
  type DomainSearchResponse,
} from '../../../api/domainsSearchApi'
import {
  RuleBasedCandidateSuggester,
  verifyCandidates,
  type CandidateSuggester,
  type CandidateSuggestion,
} from '../../domains/suggestionEngine'
import { getTldMeta, getTldPricing } from '../../domains/tldData'
import { FALLBACK_TLDS } from '../../domains/constants'
import { normalizeDomainLabel, validateDomainLabel } from '../../domains/validation'

export type CandidateOrigin = 'rule' | 'ai'

export interface AssistantDomainCandidate {
  domain: string
  label: string
  tld: string
  origin: CandidateOrigin
  /** One-line Japanese reason from the rule engine; null for AI-origin candidates. */
  reason: string | null
  /** From getTldPricing(tld); null when the TLD has no pricing entry. */
  firstYearYen: number | null
  /** TldMeta.caveat - the .dev/.app HTTPS notice etc. Mandatory to surface (registrar-spec-draft §6.2.4). */
  caveat: string | null
  /**
   * Always `true` on every candidate this module returns - unorderable TLDs
   * (no `getTldPricing` entry) are filtered out of both lists before they are
   * ever handed back (see `droppedUnorderableCount` below), so this field no
   * longer distinguishes anything within the returned arrays. It stays on the
   * type only so a caller doesn't have to special-case "was this filtered"
   * vs "was this flagged" - and it is NOT the guarantee: the filter is. A
   * caller must still not treat this as a substitute for re-validation -
   * `orderPathForDomain` re-checks `getTldPricing(tld)` itself before letting
   * an order proceed, exactly as before.
   */
  orderable: boolean
}

export interface DomainSuggestionResult {
  /**
   * Only candidates that are genuinely orderable from this screen: verified
   * `available` (never `taken`/`unknown`) AND priced (`getTldPricing`
   * returns an entry for the TLD). A candidate failing either check is
   * dropped before it reaches here - see `droppedUnorderableCount`.
   */
  ruleCandidates: AssistantDomainCandidate[]
  /** Same orderable-only guarantee as `ruleCandidates`, for the AI-proposed list. */
  aiCandidates: AssistantDomainCandidate[]
  /**
   * True when the availability check itself could not be completed (e.g. the
   * registry search call rejected) - the UI must then NOT claim availability
   * at all, and both lists are forced empty. This is distinct from the
   * ordinary case below where the check succeeded but nothing orderable came
   * out of it: `degraded: false` with two empty lists means "we checked, and
   * there is honestly no orderable candidate right now" (e.g. every verified
   * candidate landed on an unpriced TLD), not "the check failed".
   */
  degraded: boolean
  /**
   * Count of candidates that verified as `available` but were excluded
   * anyway because their TLD has no `getTldPricing` entry (this product
   * cannot accept an order for it). Only meaningful when `degraded` is
   * false - a degraded result never got far enough to verify anything.
   * A caller MAY use this to show an honest note such as
   * "他にも候補はありましたが、この画面からは申し込めないTLDのため省きました" -
   * this module does not render anything itself.
   */
  droppedUnorderableCount: number
  /** The seed label actually used for the rule engine. */
  seedLabel: string | null
}

export interface SuggestDomainsDeps {
  fetchTlds?: typeof fetchSupportedTlds
  search?: typeof searchDomains
  suggester?: CandidateSuggester
  /**
   * Domains this conversation has ALREADY shown the user, which must not come
   * back a second time.
   *
   * ⚠️ Not a test seam like the three above - a genuine per-call option, kept
   * on the same object rather than widening the signature a fourth time.
   * Without it 「さらに見たい」 re-ran the identical search and produced the
   * identical three candidates, which is what made "show me more" useless.
   *
   * Excluding after the fact is not enough: the engine only ever generates
   * `RULE_CANDIDATE_TARGET` candidates, so filtering the result would just
   * return fewer and fewer until nothing was left. The exclusion has to reach
   * the generator, which is why the request below asks for
   * `target + exclude.length` and trims afterwards.
   */
  exclude?: readonly string[]
}

const MAX_KEYWORDS = 5
const RULE_CANDIDATE_TARGET = 3
const AI_CANDIDATE_TARGET = 3

const EMPTY_RESULT: DomainSuggestionResult = {
  ruleCandidates: [],
  aiCandidates: [],
  degraded: false,
  droppedUnorderableCount: 0,
  seedLabel: null,
}

/**
 * Re-validates keywords defensively even though the caller (`playbooks.ts`'s
 * `validateLabelSlotValue`) already validated them - this module must never
 * assume an upstream caller did its job, and must never reimplement the
 * label regex itself (uses the exact validators the search page uses).
 * Splits nothing (the caller already split any comma-separated slot value
 * into an array), normalizes each entry, drops invalid ones, dedupes, and
 * caps at 5, mirroring §4.1's "comma-separated list" rule.
 */
function normalizeAndValidateKeywords(keywords: readonly string[]): string[] {
  const seen = new Set<string>()
  const valid: string[] = []
  for (const raw of keywords) {
    const normalized = normalizeDomainLabel(raw)
    if (validateDomainLabel(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    valid.push(normalized)
    if (valid.length >= MAX_KEYWORDS) break
  }
  return valid
}

function toAssistantCandidate(candidate: CandidateSuggestion, origin: CandidateOrigin): AssistantDomainCandidate {
  const pricing = getTldPricing(candidate.tld)
  const meta = getTldMeta(candidate.tld)
  return {
    domain: candidate.domain,
    label: candidate.label,
    tld: candidate.tld,
    origin,
    reason: origin === 'rule' ? candidate.reason : null,
    firstYearYen: pricing?.firstYearYen ?? null,
    caveat: meta?.caveat ?? null,
    orderable: pricing !== undefined,
  }
}

async function resolveTlds(fetchTlds: typeof fetchSupportedTlds, signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetchTlds(signal)
    return response.tlds
  } catch {
    // Same catch->fallback shape as useSupportedTlds - a failed TLD fetch is
    // not an availability failure, so this does not set `degraded`.
    return [...FALLBACK_TLDS]
  }
}

/**
 * Wraps a `search` function so a rejection can be observed by the caller
 * even though `verifyCandidates` swallows per-label search errors internally
 * (it drops the failed group and returns `[]` for it, never rethrows). The
 * wrapped function still throws (so `verifyCandidates`'s own catch keeps
 * working unchanged) - it only additionally records that a failure happened.
 */
function trackSearchFailures(search: typeof searchDomains): {
  tracked: typeof searchDomains
  failed: () => boolean
} {
  let sawFailure = false
  const tracked = async (input: DomainSearchRequest, signal?: AbortSignal): Promise<DomainSearchResponse> => {
    try {
      return await search(input, signal)
    } catch (err) {
      sawFailure = true
      throw err
    }
  }
  return { tracked, failed: () => sawFailure }
}

/**
 * Runs the §8.4 domain-candidate flow: rule-based candidates first, then
 * availability-verified AI-proposed keyword candidates, both drawn from the
 * exact same reused `features/domains` engine, availability API, and pricing
 * tables the search page uses (none of those files are modified). See the
 * file header for the "user click only" contract this function must never be
 * called outside of.
 *
 * Note: `getVerifiedSuggestions` (the convenience wrapper `suggestionEngine.ts`
 * exports) hardcodes the real `searchDomains` and cannot take an injected
 * search function, so this composes the same two calls it makes internally
 * (`suggester.suggest()` then `verifyCandidates(candidates, target, search)`)
 * directly, to honour `SuggestDomainsDeps.search` for pure, network-free tests.
 */
export async function suggestDomains(
  keywords: readonly string[],
  deps: SuggestDomainsDeps = {},
  signal?: AbortSignal,
): Promise<DomainSuggestionResult> {
  if (signal?.aborted) return EMPTY_RESULT

  const fetchTlds = deps.fetchTlds ?? fetchSupportedTlds
  const search = deps.search ?? searchDomains
  const suggester = deps.suggester ?? new RuleBasedCandidateSuggester()

  const validKeywords = normalizeAndValidateKeywords(keywords)
  const seedLabel = validKeywords[0] ?? null
  if (!seedLabel) return EMPTY_RESULT

  const tlds = await resolveTlds(fetchTlds, signal)
  if (signal?.aborted) return EMPTY_RESULT
  if (tlds.length === 0) {
    return { ruleCandidates: [], aiCandidates: [], degraded: false, droppedUnorderableCount: 0, seedLabel }
  }

  const primaryTld = tlds[0]
  // Already-shown domains for this conversation (`SuggestDomainsDeps.exclude`).
  const excluded = new Set(deps.exclude ?? [])
  const { tracked: trackedSearch, failed } = trackSearchFailures(search)

  // requestedTlds: [] deliberately, NOT `tlds` (unlike DomainSearchPage,
  // which passes requestedTlds === supportedTlds because it always searches
  // every supported TLD at once). Here the user has not searched anything
  // yet, so requestedTlds === supportedTlds would make the `alt-tld` rule
  // unable to fire by construction (suggestionEngine.ts:68-82: it only
  // proposes TLDs in `supportedTlds` that are NOT already in
  // `requestedTlds`). Passing [] keeps every supported TLD eligible for an
  // alt-tld candidate - see domainSuggestion.test.ts's dedicated assertion.
  // `+ excluded.size`: the generator returns its best N, so asking for exactly
  // N and then dropping the already-shown ones would return fewer every round
  // until nothing was left. Asking for N more than we intend to drop keeps a
  // full page available on every "show me more" (see `SuggestDomainsDeps.exclude`).
  const ruleRaw = suggester
    .suggest({
      label: seedLabel,
      requestedTlds: [],
      supportedTlds: tlds,
      maxCandidates: RULE_CANDIDATE_TARGET + excluded.size,
    })
    .filter((candidate) => !excluded.has(candidate.domain))
  const ruleVerified = await verifyCandidates(ruleRaw, RULE_CANDIDATE_TARGET, trackedSearch)
  if (signal?.aborted) return EMPTY_RESULT

  const ruleVerifiedCandidates = ruleVerified.map((candidate) => toAssistantCandidate(candidate, 'rule'))
  // Dedup set is built from ALL verified rule candidates, orderable or not -
  // an AI-proposed keyword landing on the exact same (already-considered,
  // even if unpriced) domain should not resurface it in the AI list either.
  const ruleDomains = new Set(ruleVerifiedCandidates.map((candidate) => candidate.domain))
  // §31/user request: only candidates from the curated, priced catalogue are
  // ever *recommended* - "available" alone is not enough. (/domains/new
  // itself now accepts unlisted TLDs at the server's default price; this
  // filter is about not proactively suggesting a TLD we can't quote from the
  // curated table, not about what the form can technically accept.)
  const ruleCandidates = ruleVerifiedCandidates.filter((candidate) => candidate.orderable)
  const ruleDroppedCount = ruleVerifiedCandidates.length - ruleCandidates.length

  // Every validated keyword, paired with the primary TLD - the same TLD the
  // rule engine treats as primary when requestedTlds is empty. `reason`/
  // `reasonCode` are placeholders: toAssistantCandidate discards both for
  // origin 'ai' (reason is always null - AI never gets to author reason text
  // shown as if it were a rule-engine judgment).
  const aiRaw: CandidateSuggestion[] = validKeywords
    .map((label) => ({
      label,
      tld: primaryTld,
      domain: `${label}${primaryTld}`,
      reason: '',
      reasonCode: 'alt-tld' as const,
    }))
    .filter((candidate) => !excluded.has(candidate.domain))
  const aiVerified = await verifyCandidates(aiRaw, AI_CANDIDATE_TARGET, trackedSearch)
  if (signal?.aborted) return EMPTY_RESULT

  const aiVerifiedCandidates = aiVerified
    .filter((candidate) => !ruleDomains.has(candidate.domain))
    .map((candidate) => toAssistantCandidate(candidate, 'ai'))
    .slice(0, AI_CANDIDATE_TARGET)
  const aiCandidates = aiVerifiedCandidates.filter((candidate) => candidate.orderable)
  const aiDroppedCount = aiVerifiedCandidates.length - aiCandidates.length

  if (failed()) {
    // Never present an unverified candidate as available - when any
    // availability check failed, the UI must fall back to the plain
    // DOMAIN_SEARCH navigation instead of a partially-verified list.
    // droppedUnorderableCount is only meaningful when degraded is false (a
    // failed check never got far enough to know which TLDs were unpriced).
    return { ruleCandidates: [], aiCandidates: [], degraded: true, droppedUnorderableCount: 0, seedLabel }
  }

  return {
    ruleCandidates,
    aiCandidates,
    degraded: false,
    droppedUnorderableCount: ruleDroppedCount + aiDroppedCount,
    seedLabel,
  }
}
