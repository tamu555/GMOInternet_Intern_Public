import { describe, expect, it, vi } from 'vitest'
import { DOMAIN_LABEL_MAX_LENGTH, DOMAIN_LABEL_PATTERN } from '../domains/constants'
import {
  NAME_SUGGESTION_COUNT,
  checkCandidates,
  generateNameCandidates,
  keywordsFromNote,
  noteWords,
} from './easyNameApi'

vi.mock('../../api/domainsSearchApi', () => ({
  searchDomains: vi.fn(),
}))

const { searchDomains } = await import('../../api/domainsSearchApi')
const searchDomainsMock = vi.mocked(searchDomains)

describe('keywordsFromNote', () => {
  it('extracts ASCII words usable as a domain label', () => {
    expect(keywordsFromNote('My Bakery のサイトを作りたい')).toContain('bakery')
  })

  it('never invents romaji from Japanese text', () => {
    // 読みを推測して綴りを作ることはしない。日本語は noteKeywords.ts の
    // 手書き対訳表（＝表に載っている語しか返さない）が別に受け持つ。
    expect(keywordsFromNote('駅前のパン屋のホームページ')).toEqual([])
  })

  it('drops words that could not be a valid label', () => {
    expect(keywordsFromNote('a of')).toEqual([])
  })
})

describe('noteWords', () => {
  it('本人が書いた ASCII の語を、対訳表で引いた語より先に置く', () => {
    expect(noteWords('Sakura という名前のパン屋です')).toEqual(['sakura', 'bakery'])
  })

  it('日本語だけの条件文からも語が取れる（ここが以前は空だった）', () => {
    expect(noteWords('小さなパン屋のお店紹介ページを作りたい')).toContain('bakery')
  })
})

describe('generateNameCandidates (⚠ mock suggester)', () => {
  it('only produces labels that pass the §3.4 rules', () => {
    for (const purpose of ['business', 'blog', 'shop', 'event', 'mail', 'undecided'] as const) {
      for (const candidate of generateNameCandidates({ purpose, purposeNote: 'my bakery shop' })) {
        expect(DOMAIN_LABEL_PATTERN.test(candidate.label), candidate.label).toBe(true)
        expect(candidate.label.length).toBeLessThanOrEqual(DOMAIN_LABEL_MAX_LENGTH)
        expect(candidate.label.startsWith('-')).toBe(false)
        expect(candidate.label.endsWith('-')).toBe(false)
      }
    }
  })

  it('is deterministic: the same input always yields the same list', () => {
    const input = { purpose: 'shop' as const, purposeNote: 'my bakery' }
    expect(generateNameCandidates(input)).toEqual(generateNameCandidates(input))
  })

  it('puts the label the user typed first', () => {
    const candidates = generateNameCandidates({
      purpose: 'blog',
      purposeNote: '',
      seedLabel: 'taro-note',
    })
    expect(candidates[0].label).toBe('taro-note')
  })

  it('still returns candidates when nothing usable can be extracted', () => {
    expect(generateNameCandidates({ purpose: 'event', purposeNote: 'メモ' }).length).toBeGreaterThan(0)
  })

  /** 不具合の再現：'g' と打つと company / companyoffice が返っていた。 */
  it('puts even a 1-character typed label first, verbatim', () => {
    const candidates = generateNameCandidates({
      purpose: 'business',
      purposeNote: '',
      seedLabel: 'g',
    })
    expect(candidates[0].label).toBe('g')
  })

  it('derives every other candidate from the typed label', () => {
    const candidates = generateNameCandidates({
      purpose: 'business',
      purposeNote: '小さなパン屋のお店紹介ページを作りたい',
      seedLabel: 'g',
    })
    expect(candidates.length).toBe(NAME_SUGGESTION_COUNT)
    for (const candidate of candidates) {
      expect(candidate.label.includes('g'), candidate.label).toBe(true)
    }
  })

  it('ranks the free-text condition above the purpose seeds', () => {
    const labels = generateNameCandidates({
      purpose: 'business',
      purposeNote: '小さなパン屋のお店紹介ページを作りたい',
      seedLabel: 'g',
    }).map((candidate) => candidate.label)
    expect(labels.slice(0, 3)).toEqual(['g', 'gbakery', 'g-bakery'])
  })

  it('uses a Japanese note even when no label was typed', () => {
    const labels = generateNameCandidates({
      purpose: 'business',
      purposeNote: '小さなパン屋のお店紹介ページを作りたい',
    }).map((candidate) => candidate.label)
    expect(labels[0]).toBe('bakery')
    expect(labels.every((label) => label.includes('bakery') || label.includes('shop'))).toBe(true)
  })

  it('normalizes the typed label the same way the search form does', () => {
    const [first] = generateNameCandidates({
      purpose: 'shop',
      purposeNote: '',
      seedLabel: ' Ｇ ',
    })
    expect(first.label).toBe('g')
  })

  it('falls back to the purpose seeds only when the typed label is not a legal label', () => {
    // '.' を含む文字列はラベルとして成立しない（§3.4）ので、種にはできない。
    const labels = generateNameCandidates({
      purpose: 'business',
      purposeNote: '',
      seedLabel: 'my.shop',
    }).map((candidate) => candidate.label)
    expect(labels[0]).toBe('company')
  })

  it('is deterministic across two calls, typed label included', () => {
    const input = {
      purpose: 'business' as const,
      purposeNote: '北九州のパン屋です',
      seedLabel: 'g',
    }
    expect(generateNameCandidates(input)).toEqual(generateNameCandidates(input))
  })
})

describe('checkCandidates (✅ real search API)', () => {
  it('reports available only when the API confirmed at least one free TLD', async () => {
    searchDomainsMock.mockResolvedValue({
      label: 'shop',
      maintenanceUntil: null,
      results: [
        { tld: '.com', domain: 'shop.com', state: 'taken' },
        { tld: '.net', domain: 'shop.net', state: 'available' },
      ],
    })

    const [result] = await checkCandidates(['shop'], ['.com', '.net'])
    expect(result.state).toBe('available')
    expect(result.availableTlds).toEqual(['.net'])
  })

  it('reports taken only when every checked TLD came back taken', async () => {
    searchDomainsMock.mockResolvedValue({
      label: 'shop',
      maintenanceUntil: null,
      results: [
        { tld: '.com', domain: 'shop.com', state: 'taken' },
        { tld: '.net', domain: 'shop.net', state: 'taken' },
      ],
    })

    expect((await checkCandidates(['shop'], ['.com', '.net']))[0].state).toBe('taken')
  })

  /** §6.7: 通信できなかったことは「使用中」の証拠ではない。 */
  it('reports unknown - never taken - when the lookup itself failed', async () => {
    searchDomainsMock.mockRejectedValue(new Error('network down'))

    expect((await checkCandidates(['shop'], ['.com']))[0].state).toBe('unknown')
  })

  it('reports unknown when a registry did not answer for some TLDs', async () => {
    searchDomainsMock.mockResolvedValue({
      label: 'shop',
      maintenanceUntil: null,
      results: [
        { tld: '.com', domain: 'shop.com', state: 'taken' },
        { tld: '.xyz', domain: 'shop.xyz', state: 'unknown', unknownReason: 'timeout' },
      ],
    })

    expect((await checkCandidates(['shop'], ['.com', '.xyz']))[0].state).toBe('unknown')
  })

  it('does not call the API at all when no TLD is known yet', async () => {
    searchDomainsMock.mockClear()
    expect((await checkCandidates(['shop'], []))[0].state).toBe('unknown')
    expect(searchDomainsMock).not.toHaveBeenCalled()
  })
})

/**
 * ⚠️ 2026-08-28 の回帰。条件欄に URL やサービス名を書いた人の文では、ASCII の
 * 語だけで上限（NOTE_WORD_LIMIT）が埋まり、日本語で書いた本題が 1 語も通らな
 * かった。「くわしい条件を効かせる」のが目的の欄で、日本語側だけ押し出される
 * のは本末転倒なので、両方の取り口に必ず枠を回す。
 */
describe('noteWords: 日本語と ASCII が混ざった条件', () => {
  it('URL を貼られても対訳表の語が押し出されない', () => {
    const words = noteWords('今 https://example.wixsite.com/mybakery で作っているパン屋のページを移したい')
    expect(words).toContain('bakery')
  })

  it('URL の定型部品は種にしない', () => {
    const words = noteWords('https://www.example.com のパン屋のページ')
    expect(words).not.toContain('https')
    expect(words).not.toContain('www')
    expect(words).not.toContain('com')
  })

  it('ASCII のサービス名が 3 つ並んでも日本語の本題を残す', () => {
    const words = noteWords('WordPressとShopifyとSquareで小さなパン屋のページ')
    expect(words).toContain('bakery')
    expect(words[0]).toBe('wordpress')
  })
})

