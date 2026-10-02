/**
 * Machine-verifies the doc registry (design contract §5.1): a bad entry here
 * must fail CI before it can ever reach a user as a rendered `<a href>`.
 */
import { describe, expect, it } from 'vitest'
import { DNS_RECIPES } from '../../dns/recipes'
import {
  ASSISTANT_DOC_SOURCES,
  DOC_PUBLISHER_HOSTS,
  findDocSource,
  type DocTopic,
} from './docSources'

const VALID_TOPICS: readonly DocTopic[] = ['custom-domain', 'nameserver', 'verification', 'email', 'glossary']
const RECIPE_IDS = new Set(DNS_RECIPES.map((recipe) => recipe.id))

describe('ASSISTANT_DOC_SOURCES', () => {
  it(
    // 26 total: 14 provider-specific (non-null providerId, each a real
    // DNS_RECIPES id) + 12 glossary (providerId === null). Split into three
    // assertions so a future edit that drops a row fails with a message that
    // says which half shrank, instead of a single opaque length mismatch.
    'has 26 entries: 14 with a non-null providerId (a real DNS_RECIPES id) + 12 glossary (providerId === null)',
    () => {
      const providerEntries = ASSISTANT_DOC_SOURCES.filter((source) => source.providerId !== null)
      const glossaryEntries = ASSISTANT_DOC_SOURCES.filter((source) => source.providerId === null)

      expect(providerEntries.length).toBe(14)
      expect(glossaryEntries.length).toBe(12)
      expect(ASSISTANT_DOC_SOURCES.length).toBe(providerEntries.length + glossaryEntries.length)
      for (const source of providerEntries) {
        expect(RECIPE_IDS.has(source.providerId!)).toBe(true)
      }
      expect(glossaryEntries.every((source) => source.topic === 'glossary')).toBe(true)
    },
  )

  it('has unique, non-empty ids', () => {
    const ids = ASSISTANT_DOC_SOURCES.map((source) => source.id)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(ASSISTANT_DOC_SOURCES.map((source) => [source.id, source] as const))(
    '%s: url is https and its hostname matches the declared hostname',
    (_id, source) => {
      expect(source.url.startsWith('https://')).toBe(true)
      expect(new URL(source.url).hostname).toBe(source.hostname)
    },
  )

  it('every hostname is in DOC_PUBLISHER_HOSTS', () => {
    for (const source of ASSISTANT_DOC_SOURCES) {
      expect(DOC_PUBLISHER_HOSTS).toContain(source.hostname)
    }
  })

  it('DOC_PUBLISHER_HOSTS has no entries the registry does not use', () => {
    const usedHosts = new Set(ASSISTANT_DOC_SOURCES.map((source) => source.hostname))
    for (const host of DOC_PUBLISHER_HOSTS) expect(usedHosts).toContain(host)
  })

  it('providerId is null or a real DNS_RECIPES id', () => {
    for (const source of ASSISTANT_DOC_SOURCES) {
      if (source.providerId === null) continue
      expect(RECIPE_IDS.has(source.providerId)).toBe(true)
    }
  })

  it('topic is always a valid DocTopic', () => {
    for (const source of ASSISTANT_DOC_SOURCES) {
      expect(VALID_TOPICS).toContain(source.topic)
    }
  })

  it('title is non-empty and written in Japanese (contains a kana/kanji character)', () => {
    const JAPANESE_CHAR_PATTERN = /[぀-ヿ㐀-鿿]/
    for (const source of ASSISTANT_DOC_SOURCES) {
      expect(source.title.length).toBeGreaterThan(0)
      expect(JAPANESE_CHAR_PATTERN.test(source.title)).toBe(true)
    }
  })

  it('no url carries a tracking query string', () => {
    for (const source of ASSISTANT_DOC_SOURCES) {
      expect(source.url).not.toMatch(/[?&]utm_/i)
    }
  })

  it('glossary entries have providerId === null, and provider entries do not', () => {
    for (const source of ASSISTANT_DOC_SOURCES) {
      if (source.topic === 'glossary') {
        expect(source.providerId).toBeNull()
      } else {
        expect(source.providerId).not.toBeNull()
      }
    }
  })
})

describe('findDocSource', () => {
  it('returns the matching entry by id', () => {
    expect(findDocSource('glossary-dns')?.title).toBe('DNS（ドメインネームシステム）とは')
  })

  it('returns undefined for an unknown id', () => {
    expect(findDocSource('does-not-exist')).toBeUndefined()
  })
})
