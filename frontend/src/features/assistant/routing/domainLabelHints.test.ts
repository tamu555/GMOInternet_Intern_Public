import { describe, expect, it } from 'vitest'
import { labelHintsFromText, PURPOSE_SUGGESTIONS } from './domainLabelHints'

describe('labelHintsFromText', () => {
  it('the headline case: 「ポートフォリオ用のWebサイトを公開したい」 yields "portfolio" first', () => {
    const result = labelHintsFromText('ポートフォリオ用のWebサイトを公開したい')
    expect(result[0]).toBe('portfolio')
  })

  it.each([
    ['パン屋のホームページを作りたい', 'bakery'],
    ['近所のベーカリー用にドメインが欲しい', 'bakery'],
    ['カフェのサイトを公開したい', 'cafe'],
    ['ブログを始めたい', 'blog'],
    ['会社のホームページを作りたい', 'company'],
    ['企業サイトを公開したい', 'company'],
    ['お店のサイトを作りたい', 'shop'],
    ['ショップサイトを公開したい', 'shop'],
    ['写真を公開するサイトを作りたい', 'photo'],
    ['教室のホームページを作りたい', 'school'],
    ['病院のサイトを作りたい', 'clinic'],
    ['クリニックのホームページを公開したい', 'clinic'],
    ['美容室のサイトを作りたい', 'salon'],
    ['名刺代わりのサイトを作りたい', 'card'],
    ['日記を公開したい', 'diary'],
    ['作品をまとめたサイトを作りたい', 'works'],
  ])('%s -> includes dictionary hint %s', (input, expected) => {
    expect(labelHintsFromText(input)).toContain(expected)
  })

  it('picks up an ASCII word already present in the input, lower-cased', () => {
    expect(labelHintsFromText('myshopというサイトを作りたい')).toContain('myshop')
    expect(labelHintsFromText('MyShopというサイトを作りたい')).toContain('myshop')
  })

  it('orders dictionary hits before ASCII words found in the same input', () => {
    const result = labelHintsFromText('myshopというカフェのサイトを作りたい')
    expect(result.indexOf('cafe')).toBeLessThan(result.indexOf('myshop'))
  })

  it('deduplicates and caps at 5 hints', () => {
    const manyWords = 'aaa bbb ccc ddd eee fff ggg'
    const result = labelHintsFromText(manyWords)
    expect(result.length).toBeLessThanOrEqual(5)
    expect(new Set(result).size).toBe(result.length)
  })

  it('every returned hint passes the real domain-label validators (never a bespoke regex)', () => {
    const result = labelHintsFromText('ポートフォリオ用のmyshop!!!サイトを作りたい')
    for (const hint of result) {
      expect(hint).toMatch(/^[a-z0-9-]+$/)
      expect(hint.startsWith('-')).toBe(false)
      expect(hint.endsWith('-')).toBe(false)
    }
  })

  it('returns [] when nothing in the dictionary or an ASCII word matches', () => {
    expect(labelHintsFromText('こんにちは、何をすればいいですか')).toEqual([])
  })

  it('never attempts kana->romaji transliteration of an unrecognised noun', () => {
    // 「美容院」(a plausible but not dictionary-listed synonym of 「美容室」)
    // must not silently romanise to something like "biyouin" - see the
    // module doc's explicit "no transliteration" rule.
    expect(labelHintsFromText('美容院のサイトを作りたい')).toEqual([])
  })
})

describe('PURPOSE_SUGGESTIONS (v1.5 "ask what kind of site" shortcut buttons)', () => {
  it('is non-empty and has no duplicate term or label', () => {
    expect(PURPOSE_SUGGESTIONS.length).toBeGreaterThan(0)
    expect(new Set(PURPOSE_SUGGESTIONS.map((s) => s.term)).size).toBe(PURPOSE_SUGGESTIONS.length)
    expect(new Set(PURPOSE_SUGGESTIONS.map((s) => s.label)).size).toBe(PURPOSE_SUGGESTIONS.length)
  })

  it('every term resolves through labelHintsFromText to its own stated label - the contract that makes the buttons work', () => {
    for (const { term, label } of PURPOSE_SUGGESTIONS) {
      expect(labelHintsFromText(term)).toContain(label)
    }
  })
})
