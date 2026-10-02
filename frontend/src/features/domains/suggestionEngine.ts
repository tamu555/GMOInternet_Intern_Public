/**
 * Similar-domain suggestions when nothing searched for was available
 * (spec §6.2.4, "空きなし時の類似候補提案").
 *
 * The core is rule-based and offline - no AI. The spec is explicit that this
 * is a deliberate scope boundary (§6.2.4 / TBD #20), not a
 * shortcut. `CandidateSuggester` is an interface so the generation strategy
 * can be swapped later without touching callers - the same "differences get
 * absorbed behind one interface" shape as the BRIDGE layer (spec §4.2).
 *
 * Generated candidates are proposals only; `getVerifiedSuggestions` re-checks
 * every one against the real search API before it is shown. A candidate is
 * never presented as "available" on the strength of the generator alone -
 * that would recreate exactly the false-availability problem spec §6.7 warns
 * about, just one screen earlier.
 */
import { searchDomains } from '../../api/domainsSearchApi'
import { DOMAIN_LABEL_MAX_LENGTH, DOMAIN_LABEL_PATTERN, SUGGESTION_TARGET_COUNT } from './constants'

export type SuggestionReasonCode = 'alt-tld' | 'suffix-word' | 'hyphenated' | 'shortened'

export type CandidateSuggestion = {
  label: string
  tld: string
  domain: string
  reason: string
  reasonCode: SuggestionReasonCode
}

export type SuggestionInput = {
  /** The label the user actually searched for. */
  label: string
  /** TLDs already checked for `label` (excluded from the alt-tld rule). */
  requestedTlds: string[]
  /** The full supported-TLD list (spec §4.3: fetched, not hardcoded). */
  supportedTlds: string[]
  maxCandidates?: number
}

export interface CandidateSuggester {
  suggest(input: SuggestionInput): CandidateSuggestion[]
}

/** Small fixed dictionary for the suffix/hyphenated rules - deterministic, no dictionary lookup service. */
const SUFFIX_WORDS = ['shop', 'web', 'online', 'store'] as const

const MAX_RAW_CANDIDATES = 12

function isSafeLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= DOMAIN_LABEL_MAX_LENGTH &&
    DOMAIN_LABEL_PATTERN.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  )
}

/**
 * Deterministic, synchronous, no network access - every candidate it emits
 * has already been re-validated against the same §3.4 rules the search form
 * enforces, so the engine can never propose a name that would itself 400.
 */
export class RuleBasedCandidateSuggester implements CandidateSuggester {
  suggest(input: SuggestionInput): CandidateSuggestion[] {
    const candidates: CandidateSuggestion[] = []
    const alreadyRequested = new Set(input.requestedTlds)
    const primaryTld = input.requestedTlds[0] ?? input.supportedTlds[0]

    if (isSafeLabel(input.label)) {
      for (const tld of input.supportedTlds) {
        if (alreadyRequested.has(tld)) continue
        candidates.push({
          label: input.label,
          tld,
          domain: `${input.label}${tld}`,
          reason: `同じ文字列を ${tld} で試せます`,
          reasonCode: 'alt-tld',
        })
      }
    }

    if (primaryTld) {
      for (const word of SUFFIX_WORDS) {
        const variantLabel = `${input.label}${word}`
        if (!isSafeLabel(variantLabel)) continue
        candidates.push({
          label: variantLabel,
          tld: primaryTld,
          domain: `${variantLabel}${primaryTld}`,
          reason: `「${word}」を後ろに付けた候補です`,
          reasonCode: 'suffix-word',
        })
      }

      for (const word of SUFFIX_WORDS) {
        const variantLabel = `${input.label}-${word}`
        if (!isSafeLabel(variantLabel)) continue
        candidates.push({
          label: variantLabel,
          tld: primaryTld,
          domain: `${variantLabel}${primaryTld}`,
          reason: `ハイフンで「${word}」を区切って付けた候補です`,
          reasonCode: 'hyphenated',
        })
      }

      if (input.label.length > 4) {
        const variantLabel = input.label.slice(0, -1)
        if (isSafeLabel(variantLabel)) {
          candidates.push({
            label: variantLabel,
            tld: primaryTld,
            domain: `${variantLabel}${primaryTld}`,
            reason: '文字数を1つ短くした候補です',
            reasonCode: 'shortened',
          })
        }
      }
    }

    return candidates.slice(0, MAX_RAW_CANDIDATES)
  }
}

/**
 * Confirms availability for a batch of generated candidates via the real
 * search API, grouping same-label candidates into one multi-TLD call.
 * A candidate whose verification call fails is dropped, never shown.
 */
export async function verifyCandidates(
  candidates: CandidateSuggestion[],
  targetCount: number,
  search: typeof searchDomains = searchDomains,
): Promise<CandidateSuggestion[]> {
  const byLabel = new Map<string, CandidateSuggestion[]>()
  for (const candidate of candidates) {
    const group = byLabel.get(candidate.label)
    if (group) group.push(candidate)
    else byLabel.set(candidate.label, [candidate])
  }

  const verifiedGroups = await Promise.all(
    [...byLabel.entries()].map(async ([label, group]) => {
      try {
        const response = await search({ label, tlds: group.map((candidate) => candidate.tld) })
        const availableTlds = new Set(
          response.results.filter((result) => result.state === 'available').map((result) => result.tld),
        )
        return group.filter((candidate) => availableTlds.has(candidate.tld))
      } catch {
        return []
      }
    }),
  )

  return verifiedGroups.flat().slice(0, targetCount)
}

export async function getVerifiedSuggestions(
  input: SuggestionInput,
  suggester: CandidateSuggester = new RuleBasedCandidateSuggester(),
): Promise<CandidateSuggestion[]> {
  const candidates = suggester.suggest(input)
  return verifyCandidates(candidates, input.maxCandidates ?? SUGGESTION_TARGET_COUNT)
}
