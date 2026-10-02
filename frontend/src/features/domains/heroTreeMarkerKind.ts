/**
 * マーカーの意味 — どの「期限までの距離」にどれが出て、どこに置かれるか。
 *
 * ドメイン1件＝1つのマーカーで、**形が期限までの距離**を表す。実っているものは
 * 健やか、動いているものは手が要る、落ちたものは失われかけている、の3つで読める。
 * プレミアムTLDは形ではなく素材を変える（金の実＋きらめき）— 形の軸は期限なので、
 * プレミアム専用の形を作ると意味の軸が2本ぶつかる。
 *
 * 絵は heroTreeMarkers.tsx。ここには部品を置かない（純粋な対応表なので、
 * ロジックだけを単体で試せるようにしてある）。
 */

import type { DomainStatusTone } from './domainStatusLabels'

/** 期限の帯のしきい値（日）。mypage の expiryIndicatorClass と同じ 30 / 90。 */
export const SOON_DAYS = 30
export const NEAR_DAYS = 90

export type MarkerKind = 'ripe' | 'gold' | 'flying' | 'bloom' | 'near' | 'soon' | 'gone' | 'unknown'

export type MarkerMeta = {
  /** どこに置けるか。bark が空の段階（芽）では foliage に落ちる。 */
  home: 'foliage' | 'bark' | 'ground'
  /** 置き場所に合わせる基準点。地面のものは足もと。 */
  anchor: 'center' | 'bottom'
  /** 影の付き方。留まるものだけ接地させ、飛ぶものは下へ離してぼかす。 */
  shade: 'sit' | 'fly' | 'root'
  /** 種類ごとの見え方をそろえる倍率。 */
  scale: number
  label: string
  band: string
  premium?: boolean
}

export const MARKER_KINDS: Record<MarkerKind, MarkerMeta> = {
  ripe: {
    home: 'foliage', anchor: 'center', shade: 'sit', scale: 1.15,
    label: '熟した実', band: '余裕あり',
  },
  gold: {
    home: 'foliage', anchor: 'center', shade: 'sit', scale: 1.2, premium: true,
    label: '金の実', band: '余裕あり（プレミアム）',
  },
  flying: {
    home: 'foliage', anchor: 'center', shade: 'fly', scale: 1.3,
    label: 'ちょうちょ', band: '余裕あり',
  },
  bloom: {
    home: 'ground', anchor: 'bottom', shade: 'root', scale: 1.95,
    label: '花', band: '余裕あり',
  },
  near: {
    home: 'bark', anchor: 'center', shade: 'sit', scale: 1.2,
    label: 'かたつむり', band: '期限が近い（31〜90日）',
  },
  soon: {
    home: 'foliage', anchor: 'center', shade: 'fly', scale: 1.0,
    label: 'はち', band: '期限が近い（30日以内）',
  },
  gone: {
    home: 'ground', anchor: 'bottom', shade: 'root', scale: 1.95,
    label: '枯れた花', band: '期限切れ・失効中',
  },
  unknown: {
    home: 'foliage', anchor: 'center', shade: 'sit', scale: 1.0,
    label: 'てんとう虫', band: '期限が分からない',
  },
}

/** 凡例と木で同じ順に並べる。 */
export const MARKER_ORDER: MarkerKind[] = [
  'ripe', 'gold', 'flying', 'bloom', 'near', 'soon', 'gone', 'unknown',
]

/** 余裕がある帯の3種の配分。実を厚くしないと樹冠が薄くなり「実る木」に見えない。 */
const CALM_MIX: MarkerKind[] = [
  ...Array<MarkerKind>(14).fill('ripe'),
  ...Array<MarkerKind>(4).fill('flying'),
  ...Array<MarkerKind>(2).fill('bloom'),
]

/**
 * 期限までの距離からマーカーを決める。
 *
 * §3.5 の ending（解約手続き中・いまなら復旧できます）は残り日数に関わらず失効側
 * へ寄せる — 手続きが始まっている以上、日数が残っていても失われかけているため。
 * プレミアムは形ではなく素材で示す（余裕がある帯の実だけ金にし、どの帯でも
 * きらめきを添える）。形の軸は期限なので、専用の形を作ると軸が2本ぶつかる。
 */
export function markerKindFor(domain: {
  name: string
  /** 残り日数。exDate が無いときは null。 */
  days: number | null
  tone: DomainStatusTone
  premium: boolean
}): MarkerKind {
  if (domain.days === null) return 'unknown'
  if (domain.days <= 0 || domain.tone === 'ending') return 'gone'
  if (domain.days <= SOON_DAYS) return 'soon'
  if (domain.days <= NEAR_DAYS) return 'near'
  if (domain.premium) return 'gold'
  // 同じドメインが毎回同じ姿になるよう、名前から決める。
  const hash = [...domain.name].reduce((carry, char) => (carry * 31 + char.charCodeAt(0)) % 9973, 7)
  return CALM_MIX[hash % CALM_MIX.length]
}
