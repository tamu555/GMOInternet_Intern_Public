/**
 * 期限までの距離 → マーカー。木の「読み方」そのものなので、部品を描かずに
 * ここで固定しておく（しきい値がずれると、木が言っていることが変わる）。
 */
import { describe, expect, it } from 'vitest'
import { markerKindFor } from './heroTreeMarkerKind'

const domain = (over: Partial<Parameters<typeof markerKindFor>[0]> = {}) =>
  markerKindFor({ name: 'shop.com', days: 200, tone: 'ok', premium: false, ...over })

describe('期限の帯', () => {
  it('91日以上あるものは、実・ちょうちょ・花のどれか', () => {
    expect(['ripe', 'flying', 'bloom']).toContain(domain({ days: 91 }))
    expect(['ripe', 'flying', 'bloom']).toContain(domain({ days: 900 }))
  })

  it('31〜90日はかたつむり', () => {
    expect(domain({ days: 90 })).toBe('near')
    expect(domain({ days: 31 })).toBe('near')
  })

  it('30日以内ははち', () => {
    expect(domain({ days: 30 })).toBe('soon')
    expect(domain({ days: 1 })).toBe('soon')
  })

  it('期限切れは枯れた花', () => {
    expect(domain({ days: 0 })).toBe('gone')
    expect(domain({ days: -40 })).toBe('gone')
  })

  it('期限が分からないものはてんとう虫', () => {
    expect(domain({ days: null })).toBe('unknown')
  })
})

describe('ステータスと期限の優先', () => {
  it('解約手続き中・復旧猶予中は、日数が残っていても枯れた花', () => {
    expect(domain({ days: 300, tone: 'ending' })).toBe('gone')
  })

  it('それ以外の §3.5 は形を変えない（形の軸は期限だけ）', () => {
    for (const tone of ['inactive', 'pending', 'hold', 'locked', 'neutral'] as const) {
      expect(domain({ days: 20, tone })).toBe('soon')
      expect(domain({ days: 60, tone })).toBe('near')
    }
  })
})

describe('プレミアム', () => {
  it('余裕がある帯では金の実になる', () => {
    expect(domain({ days: 200, premium: true })).toBe('gold')
  })

  it('期限が近い・切れている帯では形を変えない（きらめきだけが添えられる）', () => {
    expect(domain({ days: 20, premium: true })).toBe('soon')
    expect(domain({ days: 60, premium: true })).toBe('near')
    expect(domain({ days: -1, premium: true })).toBe('gone')
  })
})

describe('見た目の安定', () => {
  it('同じドメインは何度呼んでも同じ姿になる', () => {
    const first = domain({ name: 'garden.org', days: 250 })
    expect(domain({ name: 'garden.org', days: 250 })).toBe(first)
    expect(domain({ name: 'garden.org', days: 400 })).toBe(first)
  })

  it('余裕がある帯は実が多数派（樹冠が薄くならないように）', () => {
    const names = Array.from({ length: 200 }, (_, i) => `site${i}.com`)
    const ripe = names.filter((name) => domain({ name, days: 300 }) === 'ripe').length
    expect(ripe / names.length).toBeGreaterThan(0.55)
  })
})
