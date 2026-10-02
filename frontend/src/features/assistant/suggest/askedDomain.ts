/**
 * Extracts the specific domain a user asked about from their OWN message, and
 * checks its availability.
 *
 * ⚠️ FR-17 / §8.4 boundary, and the reason this module is separate from
 * `domainSuggestion.ts`: the read-only `searchDomains` Callable may only ever
 * run from an explicit user action. `parseAskedDomain` reads the user's raw,
 * `normalizeUserInput`-ed text and nothing else - never the model's output, no
 * part of a decision, no slot value the LLM filled. That is what keeps the
 * property §8.4 cites OWASP LLM06 (Excessive Agency) for: **the model cannot
 * cause a backend call**, no matter what it emits. A user typing
 * 「a.comは取得できる?」 is the human in the loop; the LLM is not consulted at
 * all on this path.
 *
 * The TLD is validated against `getTldPricing` - the same local, compile-time
 * table `/domains/new` uses - so no network call is needed to decide whether a
 * question is even answerable, and a domain this product could never sell is
 * never sent to the registry.
 */
import { searchDomains } from '../../../api/domainsSearchApi'
import { getTldPricing } from '../../domains/tldData'
import { normalizeDomainLabel, validateDomainLabel } from '../../domains/validation'

export interface AskedDomain {
  /** Bare label, no dot - already `validateDomainLabel`-clean. */
  label: string
  /** Leading-dot form, e.g. `.com`. Guaranteed to have a `getTldPricing` entry. */
  tld: string
  /** `label + tld`, the exact string to show the user back. */
  domain: string
}

/**
 * A domain-shaped token: one label, one dot, one alphabetic TLD. Deliberately
 * NOT multi-level (`a.co.jp` is out of scope here) - `getTldPricing` is keyed
 * on the single-segment TLDs this product sells, so anything else could not be
 * answered usefully anyway and is better left to the search screen.
 */
const DOMAIN_TOKEN_PATTERN = /(?:^|[\s「『（(])([a-zA-Z0-9][a-zA-Z0-9-]{0,62})\.([a-zA-Z]{2,24})\b/

/**
 * The specific domain named in `normalizedInput`, or `null`.
 *
 * `null` for anything not answerable: no domain-shaped token, a label that
 * fails the search page's own validator, or a TLD this product does not sell.
 * Returning `null` means "fall through to the normal pipeline" - never a
 * guess, and never a Callable.
 */
export function parseAskedDomain(normalizedInput: string): AskedDomain | null {
  const match = DOMAIN_TOKEN_PATTERN.exec(normalizedInput)
  if (!match) return null

  const label = normalizeDomainLabel(match[1] ?? '')
  if (validateDomainLabel(label) !== undefined) return null

  const tld = `.${(match[2] ?? '').toLowerCase()}`
  // Not orderable here means this screen could not act on the answer, so the
  // honest move is to say nothing rather than report on a domain the user
  // cannot buy from us.
  if (!getTldPricing(tld)) return null

  return { label, tld, domain: `${label}${tld}` }
}

export type AskedDomainState = 'available' | 'taken' | 'unknown'

export interface AskedDomainResult {
  domain: string
  state: AskedDomainState
  /** First-year registration price in JPY when known, for an `available` answer. */
  priceJpy: number | null
}

/** Test seam, mirroring `domainSuggestion.ts`'s `SuggestDomainsDeps`. */
export interface CheckAskedDomainDeps {
  search?: typeof searchDomains
}

/**
 * Availability of one specific domain (§8.4's read-only `searchDomains`).
 *
 * ⚠️ `unknown` is a first-class answer, not an error to hide: the registry not
 * answering is different from the domain being taken, and §31's honesty rule
 * ("never claim availability that was not verified") cuts both ways - we must
 * not claim it is FREE, and must not claim it is TAKEN either. Every failure
 * path resolves to `unknown` rather than throwing, so a caller can always say
 * something true.
 */
export async function checkAskedDomain(
  asked: AskedDomain,
  deps: CheckAskedDomainDeps = {},
  signal?: AbortSignal,
): Promise<AskedDomainResult> {
  const search = deps.search ?? searchDomains
  const pricing = getTldPricing(asked.tld)
  try {
    const response = await search({ label: asked.label, tlds: [asked.tld] }, signal)
    const hit = response.results.find((result) => result.tld === asked.tld)
    const state: AskedDomainState = hit?.state === 'available' || hit?.state === 'taken' ? hit.state : 'unknown'
    return {
      domain: asked.domain,
      state,
      priceJpy: state === 'available' ? (pricing?.firstYearYen ?? null) : null,
    }
  } catch {
    return { domain: asked.domain, state: 'unknown', priceJpy: null }
  }
}
