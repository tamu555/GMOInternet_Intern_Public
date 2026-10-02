import { describe, expect, it } from 'vitest'
import { EASY_PURPOSE_OPTIONS } from './purposeOptions'
import {
  ALL_PRIORITY_TLDS,
  EASY_TLD_FILTERS,
  KNOWN_TLDS,
  PURPOSE_TLD_PRIORITY,
  fitForTld,
  rankByPurpose,
  rankTlds,
  reasonForPurposeTld,
} from './purposeTldPriority'

describe('PURPOSE_TLD_PRIORITY data integrity', () => {
  /**
   * 取り扱いのない TLD を推薦すると、createOrder が「このTLDは取り扱っていません」
   * で弾く画面を作ってしまう。表の全 TLD が実在することをここで固定する。
   */
  it('names only TLDs that the registries actually serve', () => {
    for (const tld of ALL_PRIORITY_TLDS) {
      expect(KNOWN_TLDS.has(tld), tld).toBe(true)
    }
  })

  it('defines a priority list for every purpose option', () => {
    for (const option of EASY_PURPOSE_OPTIONS) {
      expect(PURPOSE_TLD_PRIORITY[option.kind].length).toBeGreaterThan(0)
    }
  })

  it('has no duplicate entry inside one purpose list', () => {
    for (const [purpose, list] of Object.entries(PURPOSE_TLD_PRIORITY)) {
      expect(new Set(list).size, purpose).toBe(list.length)
    }
  })
})

describe('rankByPurpose', () => {
  const input = ['.xyz', '.com', '.store', '.net'] as const

  it('puts the purpose priority first', () => {
    expect(rankByPurpose(input, 'shop')[0]).toBe('.store')
    expect(rankByPurpose(input, 'business')[0]).toBe('.com')
  })

  it('orders off-table entries by general recognition, not alphabetically', () => {
    /* 優先度表に載っていない2件。以前はここが「渡した順」のままで、渡す側
       （検索API）がアルファベット順なので「おすすめ」がアルファベット順に
       見えていた。いまは TLD_METADATA の並び（認知度順）で決まるので、
       アルファベットでは後ろの .sbs が .cfd より先に来る。 */
    expect(rankByPurpose(['.cfd', '.sbs', '.com'], 'business')).toEqual(['.com', '.sbs', '.cfd'])
    // 渡す順を変えても答えは変わらない（入力順に依存しない）。
    expect(rankByPurpose(['.sbs', '.cfd', '.com'], 'business')).toEqual(['.com', '.sbs', '.cfd'])
  })

  it('does not mutate the input array', () => {
    const original = [...input]
    rankByPurpose(original, 'shop')
    expect(original).toEqual([...input])
  })
})

describe('rankTlds', () => {
  const input = ['.xyz', '.com', '.store', '.net'] as const

  it('sorts by the first-year price for the price filter', () => {
    expect(rankTlds(input, 'price')[0]).toBe('.xyz')
  })

  /**
   * ⚠️ 「おすすめ」は一覧の並び替えの軸ではない（2026-08-28）。目的順は画面上部の
   * おすすめ帯が常に持つ独立した並びで、利用者が選ぶものではないため、
   * EASY_TLD_FILTERS からも EasyTldFilter からも外してある。
   */
  it('does not offer a purpose-order axis', () => {
    expect(EASY_TLD_FILTERS.map((entry) => entry.id)).toEqual(['price', 'japan', 'business'])
  })

  it('does not mutate the input array', () => {
    const original = [...input]
    rankTlds(original, 'price')
    expect(original).toEqual([...input])
  })

  it('handles every declared filter without throwing', () => {
    for (const filter of EASY_TLD_FILTERS) {
      expect(rankTlds(input, filter.id)).toHaveLength(input.length)
    }
  })
})

describe('reason / fit', () => {
  it('gives a purpose-specific reason for listed TLDs and a neutral one otherwise', () => {
    expect(reasonForPurposeTld('mail', '.com')).not.toBe(reasonForPurposeTld('shop', '.store'))
    expect(reasonForPurposeTld('mail', '.cfd')).toContain('取得できる末尾')
  })

  it('always returns some fit text, even for a TLD with no entry', () => {
    expect(fitForTld('.com')).toBeTruthy()
    expect(fitForTld('.not-a-real-tld')).toBeTruthy()
  })
})
