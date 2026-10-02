import { describe, expect, it, vi } from 'vitest'
import type { DomainSearchResponse } from '../../api/domainsSearchApi'
import { DOMAIN_LABEL_PATTERN } from './constants'
import { RuleBasedCandidateSuggester, verifyCandidates, type CandidateSuggestion } from './suggestionEngine'

const BASE_INPUT = {
  label: 'myshop',
  requestedTlds: ['.com'],
  supportedTlds: ['.com', '.net', '.org', '.info'],
}

describe('RuleBasedCandidateSuggester', () => {
  const suggester = new RuleBasedCandidateSuggester()

  it('is deterministic - the same input twice yields identical output', () => {
    expect(suggester.suggest(BASE_INPUT)).toEqual(suggester.suggest(BASE_INPUT))
  })

  it('never emits a candidate that would itself fail §3.4 (charset / hyphen placement / length)', () => {
    const candidates = suggester.suggest(BASE_INPUT)
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(DOMAIN_LABEL_PATTERN.test(candidate.label)).toBe(true)
      expect(candidate.label.startsWith('-')).toBe(false)
      expect(candidate.label.endsWith('-')).toBe(false)
      expect(candidate.label.length).toBeLessThanOrEqual(63)
    }
  })

  it('proposes the same label on a supported TLD that was not already requested (alt-tld)', () => {
    const candidates = suggester.suggest(BASE_INPUT)
    const altTld = candidates.find((candidate) => candidate.reasonCode === 'alt-tld')
    expect(altTld).toBeDefined()
    expect(altTld?.label).toBe('myshop')
    expect(BASE_INPUT.requestedTlds).not.toContain(altTld?.tld)
  })

  it('does not propose an alt-tld candidate for a TLD already requested', () => {
    const candidates = suggester.suggest(BASE_INPUT)
    const altTlds = candidates.filter((candidate) => candidate.reasonCode === 'alt-tld').map((candidate) => candidate.tld)
    expect(altTlds).not.toContain('.com')
  })
})

describe('verifyCandidates', () => {
  const candidates: CandidateSuggestion[] = [
    { label: 'myshop', tld: '.net', domain: 'myshop.net', reason: 'r1', reasonCode: 'alt-tld' },
    { label: 'myshopweb', tld: '.com', domain: 'myshopweb.com', reason: 'r2', reasonCode: 'suffix-word' },
    { label: 'broken', tld: '.com', domain: 'broken.com', reason: 'r3', reasonCode: 'suffix-word' },
  ]

  function stubSearch(response: Partial<Record<string, DomainSearchResponse['results']>>) {
    return vi.fn(async ({ label, tlds }: { label: string; tlds: string[] }) => {
      if (label === 'broken') throw new Error('registry unreachable')
      const results = response[label] ?? tlds.map((tld) => ({ tld, domain: `${label}${tld}`, state: 'taken' as const }))
      return { label, results }
    })
  }

  it('keeps only candidates the search API reports as available', async () => {
    const search = stubSearch({
      myshop: [{ tld: '.net', domain: 'myshop.net', state: 'available' }],
      myshopweb: [{ tld: '.com', domain: 'myshopweb.com', state: 'taken' }],
    })

    const verified = await verifyCandidates(candidates.slice(0, 2), 5, search)
    expect(verified).toEqual([{ label: 'myshop', tld: '.net', domain: 'myshop.net', reason: 'r1', reasonCode: 'alt-tld' }])
  })

  it('excludes a candidate whose verification call throws, rather than defaulting to available', async () => {
    const search = stubSearch({
      myshop: [{ tld: '.net', domain: 'myshop.net', state: 'available' }],
    })

    const verified = await verifyCandidates(candidates, 5, search)
    expect(verified.some((candidate) => candidate.label === 'broken')).toBe(false)
  })

  it('respects the target count', async () => {
    const manyCandidates: CandidateSuggestion[] = ['.net', '.org', '.info'].map((tld) => ({
      label: 'myshop',
      tld,
      domain: `myshop${tld}`,
      reason: 'r',
      reasonCode: 'alt-tld',
    }))
    const search = stubSearch({
      myshop: manyCandidates.map((candidate) => ({ tld: candidate.tld, domain: candidate.domain, state: 'available' as const })),
    })

    const verified = await verifyCandidates(manyCandidates, 2, search)
    expect(verified).toHaveLength(2)
  })
})
