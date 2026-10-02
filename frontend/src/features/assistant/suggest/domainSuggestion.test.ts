import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainSearchRequest, DomainSearchResponse, TldListResponse } from '../../../api/domainsSearchApi'
import { FALLBACK_TLDS } from '../../domains/constants'
import { RuleBasedCandidateSuggester, type CandidateSuggester, type CandidateSuggestion } from '../../domains/suggestionEngine'
import { getTldMeta, getTldPricing, TLD_METADATA } from '../../domains/tldData'
import { suggestDomains } from './domainSuggestion'

/** A `CandidateSuggester` fake that returns whatever the test hands it, ignoring the input. */
class FakeSuggester implements CandidateSuggester {
  private readonly candidates: CandidateSuggestion[]

  constructor(candidates: CandidateSuggestion[]) {
    this.candidates = candidates
  }

  suggest(): CandidateSuggestion[] {
    return this.candidates
  }
}

function fakeFetchTlds(tlds: string[]): (signal?: AbortSignal) => Promise<TldListResponse> {
  return vi.fn(async () => ({ tlds }))
}

function rejectingFetchTlds(): (signal?: AbortSignal) => Promise<TldListResponse> {
  return vi.fn(async () => {
    throw new Error('listTlds unreachable')
  })
}

/** Marks every requested {label, tld} pair as available. */
function alwaysAvailableSearch(): (input: DomainSearchRequest, signal?: AbortSignal) => Promise<DomainSearchResponse> {
  return vi.fn(async ({ label, tlds }: DomainSearchRequest) => ({
    label,
    results: tlds.map((tld) => ({ tld, domain: `${label}${tld}`, state: 'available' as const })),
  }))
}

function rejectingSearch(): (input: DomainSearchRequest, signal?: AbortSignal) => Promise<DomainSearchResponse> {
  return vi.fn(async () => {
    throw new Error('registry unreachable')
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('suggestDomains', () => {
  it('returns rule candidates first and AI candidates second, with no duplicate domains across the two lists', async () => {
    const ruleCandidates: CandidateSuggestion[] = [
      { label: 'myshop', tld: '.com', domain: 'myshop.com', reason: 'ルールの理由1', reasonCode: 'alt-tld' },
      { label: 'myshopweb', tld: '.com', domain: 'myshopweb.com', reason: 'ルールの理由2', reasonCode: 'suffix-word' },
    ]
    const search = alwaysAvailableSearch()

    const result = await suggestDomains(['myshop', 'sub'], {
      fetchTlds: fakeFetchTlds(['.com', '.net']),
      search,
      suggester: new FakeSuggester(ruleCandidates),
    })

    expect(result.degraded).toBe(false)
    expect(result.seedLabel).toBe('myshop')
    expect(result.ruleCandidates.map((c) => c.domain)).toEqual(['myshop.com', 'myshopweb.com'])
    expect(result.ruleCandidates.every((c) => c.origin === 'rule')).toBe(true)
    expect(result.ruleCandidates.every((c) => c.reason !== null)).toBe(true)

    // AI raw candidates are [myshop.com, sub.com] (validKeywords x primaryTld);
    // myshop.com collides with a rule candidate and must be dropped.
    expect(result.aiCandidates.map((c) => c.domain)).toEqual(['sub.com'])
    expect(result.aiCandidates.every((c) => c.origin === 'ai')).toBe(true)
    expect(result.aiCandidates.every((c) => c.reason === null)).toBe(true)

    const ruleDomains = new Set(result.ruleCandidates.map((c) => c.domain))
    const aiDomains = new Set(result.aiCandidates.map((c) => c.domain))
    for (const domain of aiDomains) expect(ruleDomains.has(domain)).toBe(false)
  })

  it('drops an AI keyword whose domain comes back unavailable', async () => {
    const search = vi.fn(async ({ label, tlds }: DomainSearchRequest) => ({
      label,
      results: tlds.map((tld) => ({
        tld,
        domain: `${label}${tld}`,
        state: label === 'taken' ? ('taken' as const) : ('available' as const),
      })),
    }))

    const result = await suggestDomains(['myshop', 'taken'], {
      fetchTlds: fakeFetchTlds(['.com']),
      search,
      suggester: new FakeSuggester([]),
    })

    expect(result.degraded).toBe(false)
    expect(result.aiCandidates.map((c) => c.domain)).toEqual(['myshop.com'])
  })

  it('falls back to FALLBACK_TLDS when fetchTlds rejects, and still returns candidates with degraded: false', async () => {
    const search = alwaysAvailableSearch()
    const suggester = new FakeSuggester([
      { label: 'myshop', tld: '.com', domain: 'myshop.com', reason: 'r', reasonCode: 'alt-tld' },
    ])

    const result = await suggestDomains(['myshop', 'extra'], {
      fetchTlds: rejectingFetchTlds(),
      search,
      suggester,
    })

    expect(result.degraded).toBe(false)
    expect(result.ruleCandidates.map((c) => c.domain)).toEqual(['myshop.com'])
    // The primary TLD used for the AI candidate must come from the fallback list.
    expect(result.aiCandidates.map((c) => c.domain)).toEqual([`extra${FALLBACK_TLDS[0]}`])
    expect(result.aiCandidates[0].tld).toBe(FALLBACK_TLDS[0])
  })

  it('sets degraded: true and returns empty lists when the search call rejects', async () => {
    const suggester = new FakeSuggester([
      { label: 'myshop', tld: '.com', domain: 'myshop.com', reason: 'r', reasonCode: 'alt-tld' },
    ])

    const result = await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds(['.com']),
      search: rejectingSearch(),
      suggester,
    })

    expect(result.degraded).toBe(true)
    expect(result.ruleCandidates).toEqual([])
    expect(result.aiCandidates).toEqual([])
  })

  it('drops invalid keywords and returns an empty, non-degraded result when none are valid', async () => {
    const fetchTlds = fakeFetchTlds(['.com'])
    const search = alwaysAvailableSearch()

    const result = await suggestDomains(['ドメイン', '-bad', '', 'a'.repeat(64)], {
      fetchTlds,
      search,
      suggester: new FakeSuggester([]),
    })

    expect(result.seedLabel).toBeNull()
    expect(result.ruleCandidates).toEqual([])
    expect(result.aiCandidates).toEqual([])
    expect(result.degraded).toBe(false)
    // No point resolving TLDs or hitting the search API when there is nothing to suggest for.
    expect(fetchTlds).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('produces alt-tld candidates because requestedTlds is passed as [], not the supported list', async () => {
    // suggestionEngine.ts:68-82 (RuleBasedCandidateSuggester.suggest): the
    // alt-tld loop iterates every TLD in `input.supportedTlds` that is not
    // already in `input.requestedTlds`. Passing requestedTlds: [] (verified
    // in domainSuggestion.ts) means every supported TLD is eligible, so
    // alt-tld candidates for TLDs other than the primary one must appear -
    // unlike DomainSearchPage's own call site, which passes
    // requestedTlds === supportedTlds and can never produce one.
    const result = await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds(['.com', '.net', '.org', '.info']),
      search: alwaysAvailableSearch(),
      suggester: new RuleBasedCandidateSuggester(),
    })

    expect(result.degraded).toBe(false)
    const nonPrimaryTldCandidates = result.ruleCandidates.filter((c) => c.tld !== '.com')
    expect(nonPrimaryTldCandidates.length).toBeGreaterThan(0)
  })

  it('populates price/caveat/orderable from the real tldData tables', async () => {
    // Derived from the real table rather than hard-coded: the supported TLD
    // list is product data that changes (`.dev`/`.app` were replaced wholesale
    // on main), and a test that names one breaks for reasons that have nothing
    // to do with this module. What actually matters is that SOME TLD carries a
    // caveat and that it reaches the candidate - registrar-spec-draft.md §6.2.4
    // makes surfacing the caveat mandatory.
    const caveatTld = TLD_METADATA.find((meta) => meta.caveat !== undefined)
    expect(caveatTld, 'no TLD in tldData.ts carries a caveat - §6.2.4 requires at least one').toBeDefined()
    const tld = caveatTld!.tld
    const domain = `myshop${tld}`
    expect(getTldPricing(tld)).toBeDefined()

    const suggester = new FakeSuggester([
      { label: 'myshop', tld, domain, reason: 'r1', reasonCode: 'alt-tld' },
    ])

    const result = await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds([tld]),
      search: alwaysAvailableSearch(),
      suggester,
    })

    const priced = result.ruleCandidates.find((c) => c.domain === domain)
    expect(priced).toBeDefined()
    expect(priced?.firstYearYen).toBe(getTldPricing(tld)?.firstYearYen)
    expect(priced?.caveat).toBe(getTldMeta(tld)?.caveat)
    expect(priced?.orderable).toBe(true)
    expect(result.droppedUnorderableCount).toBe(0)
  })

  it('drops a candidate on an unpriced TLD from ruleCandidates instead of showing it as unorderable (§31/B)', async () => {
    expect(getTldPricing('.example')).toBeUndefined()

    // Same reasoning as above: take a really-priced TLD from the table.
    const pricedTld = TLD_METADATA[0]!.tld
    const pricedDomain = `myshop${pricedTld}`
    expect(getTldPricing(pricedTld)).toBeDefined()

    const suggester = new FakeSuggester([
      { label: 'myshop', tld: pricedTld, domain: pricedDomain, reason: 'r1', reasonCode: 'alt-tld' },
      { label: 'myshop2', tld: '.example', domain: 'myshop2.example', reason: 'r2', reasonCode: 'suffix-word' },
    ])

    const result = await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds([pricedTld, '.example']),
      search: alwaysAvailableSearch(),
      suggester,
    })

    expect(result.ruleCandidates.map((c) => c.domain)).toEqual([pricedDomain])
    expect(result.ruleCandidates.some((c) => c.domain === 'myshop2.example')).toBe(false)
    // Every candidate this module returns is orderable; the guarantee is the
    // filter, not this field (see the type's doc comment).
    expect(result.ruleCandidates.every((c) => c.orderable)).toBe(true)
    expect(result.droppedUnorderableCount).toBe(1)
  })

  it('drops an unpriced AI candidate from aiCandidates and counts it in droppedUnorderableCount', async () => {
    const result = await suggestDomains(['myshop2'], {
      fetchTlds: fakeFetchTlds(['.example']),
      search: alwaysAvailableSearch(),
      suggester: new FakeSuggester([]),
    })

    expect(result.aiCandidates).toEqual([])
    expect(result.droppedUnorderableCount).toBe(1)
  })

  it('is distinguishable from degraded: true - all-filtered-out-as-unorderable still reports degraded: false', async () => {
    const suggester = new FakeSuggester([
      { label: 'myshop', tld: '.example', domain: 'myshop.example', reason: 'r', reasonCode: 'alt-tld' },
    ])

    const result = await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds(['.example']),
      search: alwaysAvailableSearch(),
      suggester,
    })

    expect(result.degraded).toBe(false)
    expect(result.ruleCandidates).toEqual([])
    expect(result.aiCandidates).toEqual([])
    expect(result.droppedUnorderableCount).toBeGreaterThan(0)
  })

  it('resolves empty with degraded: false when the signal is already aborted, without calling any dependency', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchTlds = fakeFetchTlds(['.com'])
    const search = alwaysAvailableSearch()

    const result = await suggestDomains(['myshop'], { fetchTlds, search }, controller.signal)

    expect(result).toEqual({
      ruleCandidates: [],
      aiCandidates: [],
      degraded: false,
      droppedUnorderableCount: 0,
      seedLabel: null,
    })
    expect(fetchTlds).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
  })

  it('never calls globalThis.fetch directly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await suggestDomains(['myshop'], {
      fetchTlds: fakeFetchTlds(['.com']),
      search: alwaysAvailableSearch(),
      suggester: new FakeSuggester([
        { label: 'myshop', tld: '.com', domain: 'myshop.com', reason: 'r', reasonCode: 'alt-tld' },
      ]),
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
