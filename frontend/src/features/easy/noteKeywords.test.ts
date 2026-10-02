import { describe, expect, it } from 'vitest'
import { NOTE_KEYWORDS, japaneseKeywordsFromNote } from './noteKeywords'

describe('japaneseKeywordsFromNote', () => {
  it('日本語の文章から、表に載っている語だけを引く', () => {
    expect(japaneseKeywordsFromNote('小さなパン屋のお店紹介ページを作りたい')).toEqual([
      'bakery',
      'shop',
    ])
  })

  it('表に無い語からは何も作らない（＝ローマ字を捏造しない）', () => {
    expect(japaneseKeywordsFromNote('祖父の思い出をまとめたい')).toEqual([])
  })

  it('長い語に当たった箇所では、その中の短い語に二重で当たらない', () => {
    // 「自転車」→ bike。ここで car まで拾うと自転車店が car になってしまう。
    expect(japaneseKeywordsFromNote('自転車の修理屋です')).toEqual(['bike'])
    expect(japaneseKeywordsFromNote('中古車の販売')).toEqual(['car'])
  })

  it('半角カナで書かれても NFKC で吸収する', () => {
    expect(japaneseKeywordsFromNote('ｶﾌｪを開きます')).toEqual(['cafe'])
  })

  it('同じ英単語は 1 回だけ返す', () => {
    expect(japaneseKeywordsFromNote('パン屋兼ベーカリーカフェ')).toEqual(['bakery', 'cafe'])
  })

  it('決定的：同じ文章からは常に同じ並びを返す', () => {
    const note = '東京の写真教室のサイト'
    expect(japaneseKeywordsFromNote(note)).toEqual(japaneseKeywordsFromNote(note))
  })

  it('表の英単語はそのままドメインラベルに使える形になっている', () => {
    for (const { ja, en } of NOTE_KEYWORDS) {
      expect(/^[a-z][a-z0-9]*$/.test(en), `${ja} -> ${en}`).toBe(true)
      expect(en.length).toBeGreaterThanOrEqual(3)
    }
  })
})

/**
 * ⚠️ 表の並びそのものが仕様。`japaneseKeywordsFromNote` は当たった箇所を伏せて
 * から先へ進むので、短い語が長い語より **先** に並んでいると、長いほうに二度と
 * 当たらない（「店」が「書店」より上にあると、「駅前の書店」が book ではなく
 * shop になる）。人が 1 行足すだけで静かに壊れるので、包含関係を総当たりで
 * 検査して並びを固定する。
 */
describe('NOTE_KEYWORDS の並び', () => {
  it('ある語を部分文字列に含む語は、必ずその語より先に並んでいる', () => {
    const violations: string[] = []
    NOTE_KEYWORDS.forEach((longer, longerIndex) => {
      NOTE_KEYWORDS.forEach((shorter, shorterIndex) => {
        if (longerIndex === shorterIndex) return
        if (!longer.ja.includes(shorter.ja)) return
        if (shorterIndex < longerIndex) {
          violations.push(`「${shorter.ja}」(${shorterIndex}) が「${longer.ja}」(${longerIndex}) より先にある`)
        }
      })
    })
    expect(violations).toEqual([])
  })
})

