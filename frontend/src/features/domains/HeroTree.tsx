/**
 * トップのヒーローに置く「ドメインの木」。
 *
 * 絵そのものは水彩タッチのラスタ3枚（芽 / 若木 / 大樹、heroTreeStages.ts）。
 * 彩度をテーマの若草に寄せて焼き込んであるので、JSX 側で色を触る必要はない。
 * 明暗の追従だけは `--hero-tree-filter`（app.css）が持つ — dark: ユーティリティ
 * は使わない（DESIGN_SYSTEM.md）。地面とマーカーと吹き出しは同じ viewBox に
 * 描く SVG。
 *
 * 木の大きさは保有件数で決まる（1-2件=芽 / 3-5件=若木 / 6件以上=大樹）。
 *
 * ログイン済みで保有ドメインがあるとき、**1件＝1つのマーカー**が木に付く。
 * 何が置かれるかは「更新期限までの距離」で決まる（heroTreeMarkers.tsx）。
 * 絵の上に文字は一切書かない — 文字を載せると水彩の葉の上にラベルを貼ったように
 * 見えるうえ、載る枚数も減る。
 *
 * 触り方は「引き算」。カーソル（またはフォーカス）を置くと、木全体とほかの
 * マーカーが引いて、そこだけが色を保ち、吹き出しに名前と状態が出る。マーカーは
 * 小さいので、当たり判定はそれを囲む見えない円が持つ。
 *
 * ⚠ 色だけに意味を持たせない（§3.5 色覚多様性対応）。形・置き場所・うごきの
 * 3つが同じことを言い、正式な文言は必ず吹き出しと aria-label に出る。木は要約
 * であって一覧の代わりではないので、マーカーは MAX_MARKERS まで。溢れた件数は
 * 木の下に数で出し、黙って捨てない。
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchMyDomains, type MyDomainSummary } from '../../api/myDomainsApi'
import { useAuth } from '../../auth/useAuth'
import { daysUntil } from '../mypage/domainDisplay'
import { labelForDomainStatus, type DomainStatusTone } from './domainStatusLabels'
import { HeroTreeAbout } from './HeroTreeAbout'
import { MARKER_KINDS, markerKindFor, type MarkerKind } from './heroTreeMarkerKind'
import { MarkerArt, MarkerSparkle } from './heroTreeMarkers'
import { HERO_TREE_SPOTS } from './heroTreeSpots'
import { TLD_METADATA } from './tldData'
import {
  ART_WIDTH,
  DEFAULT_STAGE,
  GROUND_Y,
  TRUNK_CENTER_X,
  VIEW_BOTTOM,
  stageForCount,
} from './heroTreeStages'

/** 木に置ける上限。超えた分は数だけ木の下に出す（一覧はマイページが持つ）。 */
const MAX_MARKERS = 40

/** マーカーと当たり判定の大きさ。どちらも「いちばん近い2つの間隔」から出す。 */
const MARKER_OF_SPACING = 0.62
const HIT_OF_SPACING = 0.46
const MARKER_MIN = 34
const MARKER_MAX = 58
const HIT_MIN = 20
const HIT_MAX = 46

/**
 * 地面の株を置く場所（共通座標）。絵の外なので画素からは出せない。
 * 奥（上）ほど小さく、手前（下）ほど大きくして地面の奥行きに合わせる。
 */
const GROUND_SPOTS = [
  { x: 230, y: 1051, scale: 1.0 },
  { x: 734, y: 1044, scale: 1.0 },
  { x: 317, y: 1075, scale: 1.16 },
  { x: 648, y: 1080, scale: 1.18 },
  { x: 144, y: 1031, scale: 0.84 },
  { x: 826, y: 1027, scale: 0.82 },
  { x: 432, y: 1088, scale: 1.24 },
  { x: 552, y: 1093, scale: 1.26 },
  { x: 278, y: 1037, scale: 0.9 },
  { x: 682, y: 1033, scale: 0.9 },
  { x: 370, y: 1064, scale: 1.08 },
  { x: 595, y: 1066, scale: 1.1 },
]


type TreeMarker = {
  name: string
  kind: MarkerKind
  statusLabel: string
  /** 「更新まであと◯日」など。吹き出しの3行目。 */
  when: string
  premium: boolean
  urgent: boolean
  x: number
  y: number
  scale: number
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value))

/** 1件が運ぶステータスは1つ。いちばん手当てが要るものを選ぶ。 */
const TONE_PRIORITY: DomainStatusTone[] = [
  'ending', 'hold', 'pending', 'locked', 'inactive', 'neutral', 'ok',
]

function primaryStatus(domain: MyDomainSummary) {
  return domain.statuses
    .map(labelForDomainStatus)
    .reduce(
      (carry, candidate) =>
        TONE_PRIORITY.indexOf(candidate.tone) < TONE_PRIORITY.indexOf(carry.tone) ? candidate : carry,
      labelForDomainStatus('ok'),
    )
}


/**
 * 保有ドメインの取得。失敗も0件も「ただの木に戻す」で同じ扱いにする — トップ
 * ページのイラストが、一覧を引けなかったことをエラーで訴える必要はない。
 */
function useHeldDomains(enabled: boolean): MyDomainSummary[] | null {
  const [domains, setDomains] = useState<MyDomainSummary[] | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const controller = new AbortController()
    fetchMyDomains(controller.signal)
      .then((result) => {
        if (!cancelled) setDomains(result.domains)
      })
      .catch(() => {
        if (!cancelled) setDomains([])
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [enabled])

  // ログアウト後に前のセッションの実りが残らないよう、無効化は state を書き戻す
  // のではなく描画時に捨てる（effect の中の同期 setState を増やさない）。
  return enabled ? domains : null
}

/** Poppins の実測に近い概算。半角 0.55em / 全角 1em。 */
function textWidth(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) width += (char.charCodeAt(0) < 128 ? 0.55 : 1) * fontSize
  return width
}

const GROUND_ID = 'hero-tree-ground-blur'
const BANK_ID = 'hero-tree-bank-blur'
const SOIL_ID = 'hero-tree-soil'
const TIP_ID = 'hero-tree-tip-shadow'
const SHADE_ID = 'hero-tree-shade-blur'

/** 影の形は置き方で変える。飛ぶものは接地させず、下へ離してぼかす。 */
const SHADES = {
  sit: { cy: 96, rx: 30, ry: 6, opacity: 1 },
  fly: { cy: 132, rx: 22, ry: 5, opacity: 0.5 },
  root: { cy: 100, rx: 25, ry: 4.5, opacity: 0.55 },
}

export function HeroTree({ className }: { className?: string }) {
  const { state: authState } = useAuth()
  const navigate = useNavigate()
  const held = useHeldDomains(authState.status === 'authenticated')
  const [hovered, setHovered] = useState<string | null>(null)

  // 使用不可（移管済み / 復旧不可）は「持っていない」ので木に出さない。
  const growing = (held ?? []).filter((domain) => domain.lifecycle !== 'gone')
  const stage = growing.length > 0 ? stageForCount(growing.length) : DEFAULT_STAGE
  const spots = HERO_TREE_SPOTS[stage.id]
  const shown = growing.slice(0, Math.min(MAX_MARKERS, spots?.foliage.length ?? 0))
  const overflow = growing.length - shown.length

  const artLeft = TRUNK_CENTER_X - stage.width / 2
  const artTop = GROUND_Y - stage.height
  const viewHeight = VIEW_BOTTOM - stage.viewTop

  // 数が増えるほど間隔が詰まるので、マーカーも当たり判定もそれに合わせて縮める。
  const spacing = ((spots?.spacing[shown.length - 1] ?? 1000) / 1000) * stage.width
  const size = clamp(spacing * MARKER_OF_SPACING, MARKER_MIN, MARKER_MAX)
  const hit = clamp(spacing * HIT_OF_SPACING, HIT_MIN, HIT_MAX)

  const markers = placeMarkers(shown, stage.id, { artLeft, artTop, width: stage.width, height: stage.height }, size)
  const hoveredMarker = markers.find((marker) => marker.name === hovered) ?? null
  const showsMarkers = markers.length > 0
  const open = (name: string) => navigate(`/mypage/domains/${encodeURIComponent(name)}`)

  return (
    <div className={className}>
      <svg
        viewBox={`0 ${stage.viewTop} ${ART_WIDTH} ${viewHeight}`}
        className="hero-tree block h-auto w-full"
        focusable="false"
        {...(showsMarkers
          ? { role: 'group', 'aria-label': '取得しているドメインの木' }
          : { 'aria-hidden': true })}
      >
        <defs>
          <filter id={TIP_ID} x="-25%" y="-40%" width="150%" height="190%">
            <feDropShadow dy="10" stdDeviation="14" floodColor="rgb(23 60 40)" floodOpacity="0.28" />
          </filter>
          <filter id={GROUND_ID} x="-25%" y="-120%" width="150%" height="340%">
            <feGaussianBlur stdDeviation="11" />
          </filter>
          <filter id={BANK_ID} x="-20%" y="-90%" width="140%" height="280%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
          <filter id={SHADE_ID} x="-60%" y="-160%" width="220%" height="420%">
            <feGaussianBlur stdDeviation="2" />
          </filter>
          {/* 地面は縁を持たない。単色で塗ると草地ではなく「置いた皿」になるので、
              外へ向けて透明に抜く。 */}
          <radialGradient id={SOIL_ID} cx="50%" cy="44%" r="54%">
            <stop offset="0%" stopColor="var(--grass-2)" stopOpacity="1" />
            <stop offset="58%" stopColor="var(--grass-2)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--grass-2)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ── 土台 ───────────────────────────────────────────────────
            地面は絵より先に描く。あとに描くと根が土に埋もれず、木が地面の上に
            置かれた切り抜きに見える。接地影も地面のあと・絵の前 — 地面より先に
            置くと地面の塗りに隠れて、木が浮いたままになる。
            大きさは段階をまたいで固定。ここが動くと、育ったのではなく画面が
            ズームしたように見える。 */}
        <g className="hero-tree-ground">
          <ellipse cx={TRUNK_CENTER_X} cy={GROUND_Y + 8} rx="452" ry="72" fill={`url(#${SOIL_ID})`} />
          <ellipse
            cx={TRUNK_CENTER_X}
            cy={GROUND_Y}
            rx="292"
            ry="46"
            fill="var(--grass-3)"
            opacity="0.74"
            filter={`url(#${BANK_ID})`}
          />
          {/* 接地影だけは株の太さに合わせて縮める。芽の足もとに大樹ぶんの影が
              あると、小さい絵が宙に浮いて見える。
              ここだけトークンを使わず生の暗色なのは、影は明暗どちらでも暗いから
              — 反転するトークンを入れると、ダークで根元が光ってしまう。 */}
          <ellipse
            cx={TRUNK_CENTER_X}
            cy={GROUND_Y - 12}
            rx={Math.round(stage.width * 0.16)}
            ry="22"
            fill="rgb(15 34 22)"
            opacity="0.3"
            filter={`url(#${GROUND_ID})`}
          />
        </g>

        <image
          href={stage.art}
          x={artLeft}
          y={artTop}
          width={stage.width}
          height={stage.height}
          className={`hero-tree-art ${hoveredMarker ? 'hero-tree-veil' : ''}`}
        />

        {markers.map((marker) => {
          const meta = MARKER_KINDS[marker.kind]
          const shade = SHADES[meta.shade]
          const dimmed = hoveredMarker !== null && hoveredMarker.name !== marker.name
          const k = (size * marker.scale * meta.scale) / 100
          const originY = meta.anchor === 'bottom' ? 100 : 50
          return (
            <g
              key={marker.name}
              className={`hero-tree-marker ${dimmed ? 'is-dimmed' : ''}`}
              transform={`translate(${marker.x} ${marker.y}) scale(${k}) translate(-50 -${originY})`}
              pointerEvents="none"
            >
              {/* 拡大は内側のグループが持つ。外側に CSS transform を当てると、
                  配置用の transform 属性ごと上書きされて原点へ飛ぶ（2026-08-28）。 */}
              <g
                className={`hero-tree-marker-zoom ${
                  hoveredMarker?.name === marker.name ? 'is-on' : ''
                }`}
              >
                <ellipse
                  className="hero-tree-shade"
                  cx="50"
                  cy={shade.cy}
                  rx={shade.rx}
                  ry={shade.ry}
                  opacity={shade.opacity}
                  filter={`url(#${SHADE_ID})`}
                />
                <MarkerArt kind={marker.kind} urgent={marker.urgent} />
                {marker.premium ? <MarkerSparkle /> : null}
              </g>
            </g>
          )
        })}

        {/* 当たり判定。マーカーは小さいので、それを囲む見えない円が受ける。 */}
        {markers.map((marker) => (
          <circle
            key={marker.name}
            className="hero-tree-hit"
            cx={marker.x}
            cy={marker.y - (MARKER_KINDS[marker.kind].anchor === 'bottom' ? hit * 0.5 : 0)}
            r={hit}
            fill="transparent"
            role="button"
            tabIndex={0}
            aria-label={`${marker.name}：${marker.premium ? 'プレミアムTLD・' : ''}${marker.statusLabel}（${marker.when}）`}
            onPointerEnter={() => setHovered(marker.name)}
            onPointerLeave={() => setHovered((current) => (current === marker.name ? null : current))}
            onFocus={() => setHovered(marker.name)}
            onBlur={() => setHovered((current) => (current === marker.name ? null : current))}
            onClick={() => open(marker.name)}
            onKeyDown={(event: KeyboardEvent<SVGCircleElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              open(marker.name)
            }}
          />
        ))}

        {hoveredMarker ? <MarkerTip marker={hoveredMarker} viewTop={stage.viewTop} /> : null}
      </svg>

      <div className="mt-1 flex flex-col items-center gap-0.5">
        {overflow > 0 ? <p className="text-xs text-ink-faint">ほかに{overflow}件</p> : null}
        <HeroTreeAbout counts={countKinds(markers)} />
      </div>
    </div>
  )
}

function countKinds(markers: TreeMarker[]): Partial<Record<MarkerKind, number>> {
  const counts: Partial<Record<MarkerKind, number>> = {}
  for (const marker of markers) counts[marker.kind] = (counts[marker.kind] ?? 0) + 1
  return counts
}

/**
 * ドメインを置き場所に割り当てる。置き場所は種類ごとに決まっていて、幹の枠が
 * 無い段階（芽）では葉に落ちる。
 *
 * 幹は細い縦帯なので、順番に取るだけだと かたつむり が縦に重なる。置いたものから
 * 一定距離離れるまで候補を送る（試作で実測して入れた処理）。
 */
function placeMarkers(
  domains: MyDomainSummary[],
  stageId: string,
  box: { artLeft: number; artTop: number; width: number; height: number },
  size: number,
): TreeMarker[] {
  const spots = HERO_TREE_SPOTS[stageId]
  const toCommon = (spot: { x: number; y: number }) => ({
    x: box.artLeft + (spot.x / 1000) * box.width,
    y: box.artTop + (spot.y / 1000) * box.height,
  })
  const pools: Record<'foliage' | 'bark' | 'ground', { x: number; y: number; scale?: number }[]> = {
    foliage: spots.foliage.map(toCommon),
    bark: spots.bark.length > 0 ? spots.bark.map(toCommon) : spots.foliage.map(toCommon),
    ground: GROUND_SPOTS,
  }
  const cursor = { foliage: 0, bark: 0, ground: 0 }
  const placed: Record<string, { x: number; y: number }[]> = { foliage: [], bark: [], ground: [] }
  const gap = size * 0.95

  return domains.map((domain) => {
    const status = primaryStatus(domain)
    const days = domain.exDate ? daysUntil(domain.exDate) : null
    const premium = isPremium(domain.name)
    const kind = markerKindFor({ name: domain.name, days, tone: status.tone, premium })
    const meta = MARKER_KINDS[kind]
    const pool = pools[meta.home]

    let spot = pool[cursor[meta.home] % pool.length]
    for (let tries = 0; tries < pool.length; tries += 1) {
      const candidate = pool[(cursor[meta.home] + tries) % pool.length]
      const far = placed[meta.home].every((q) => Math.hypot(q.x - candidate.x, q.y - candidate.y) >= gap)
      if (far || tries === pool.length - 1) {
        spot = candidate
        cursor[meta.home] += tries + 1
        break
      }
    }
    placed[meta.home].push(spot)

    return {
      name: domain.name,
      kind,
      statusLabel: status.label,
      when:
        days === null ? '期限が分かりません' : days <= 0 ? `期限を${-days}日過ぎています` : `更新まであと${days}日`,
      premium,
      urgent: kind === 'soon',
      x: spot.x,
      y: spot.y,
      scale: spot.scale ?? 1,
    }
  })
}

/**
 * プレミアムTLDか。TLD一覧が唯一の出どころなので、ここで名前から引き直す
 * （listDomains は tld を返さない）。
 */
function isPremium(name: string): boolean {
  const dot = name.indexOf('.')
  if (dot < 0) return false
  return PREMIUM_TLDS.has(name.slice(dot))
}

const PREMIUM_TLDS = new Set(TLD_METADATA.filter((meta) => meta.premium).map((meta) => meta.tld))

/**
 * 指しているマーカーの吹き出し。HTML の Tooltip ではなく SVG の中に描くのは、
 * マーカーの座標が viewBox の中にしかないため — 外に出すと、絵の拡縮のたびに
 * DOM 座標を測り直すことになる。
 */
function MarkerTip({ marker, viewTop }: { marker: TreeMarker; viewTop: number }) {
  const nameSize = 26
  const labelSize = 23
  const whenSize = 20
  const width =
    Math.max(
      textWidth(marker.name, nameSize),
      textWidth(marker.statusLabel, labelSize),
      textWidth(marker.when, whenSize),
    ) + 44
  const height = 108
  const x = clamp(marker.x - width / 2, 10, ART_WIDTH - width - 10)
  // 上に出せないほど樹冠のてっぺんに近いものは、下に出す。
  const above = marker.y - 46 - height
  const y = above < viewTop + 10 ? marker.y + 46 : above

  return (
    <g className="hero-tree-tip" pointerEvents="none">
      <rect x={x} y={y} width={width} height={height} fill="var(--card)" filter={`url(#${TIP_ID})`} />
      <rect x={x} y={y} width="7" height={height} fill={TIP_BAR[marker.kind]} />
      <text x={x + 24} y={y + 33} className="font-en" fontSize={nameSize} fontWeight="600" fill="var(--foreground)">
        {marker.name}
      </text>
      <text x={x + 24} y={y + 64} fontSize={labelSize} fill="var(--muted-foreground)">
        {marker.statusLabel}
      </text>
      <text x={x + 24} y={y + 91} fontSize={whenSize} fill="var(--ink-faint)">
        {marker.when}
      </text>
    </g>
  )
}

/** 吹き出し左の帯。マーカーの色ではなく §3.5 のトーン色（本番の他画面と揃える）。 */
const TIP_BAR: Record<MarkerKind, string> = {
  ripe: 'var(--green)',
  gold: 'var(--orange)',
  flying: 'var(--green)',
  bloom: 'var(--green)',
  near: 'var(--status-hold-fg)',
  soon: 'var(--orange)',
  gone: 'var(--danger)',
  unknown: 'var(--ink-faint)',
}
