/**
 * ヒーローの木に置くマーカーの語彙 — 絵と、それが何を意味するか。
 *
 * ドメイン1件＝1つのマーカーで、**形が「更新期限までの距離」**を表す。
 * 実っているものは健やか、動いているものは手が要る、落ちたものは失われかけて
 * いる、の3つで読める。プレミアムTLDは形ではなく素材を変える（金の実＋きらめき）
 * — 形の軸は期限なので、プレミアム専用の形を作ると意味の軸が2本ぶつかる。
 *
 * 意味の対応表（どの帯にどれが出るか）は heroTreeMarkerKind.ts。ここは絵だけ。
 *
 * 絵はすべて 0-100 のローカル座標で描く。置く側（HeroTree.tsx）が translate と
 * scale で共通座標へ運ぶので、ここでは大きさも位置も持たない。
 *
 * ⚠ 生きものは枝の向きに回さない。虫は葉の傾きに関係なく上を向くので、葉と同じ
 * ように回すと途端に貼り付けたように見える（試作で確認済み）。
 */
import type { ReactNode } from 'react'

import type { MarkerKind } from './heroTreeMarkerKind'

/**
 * かたつむりの殻の渦。塗った円のうえに1本引く — 輪郭線だけで描くと、拡大した
 * ときに殻ではなく輪に見える（試作で確認済み）。
 */
const SHELL_SPIRAL = (() => {
  const [cx, cy, r0, r1, turns, steps] = [38, 50, 21.5, 3.2, 2.35, 110]
  const points = Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps
    const angle = -Math.PI / 2 + turns * 2 * Math.PI * t
    const r = r0 + (r1 - r0) * t
    return `${(cx + r * Math.cos(angle)).toFixed(1)} ${(cy + r * Math.sin(angle)).toFixed(1)}`
  })
  return `M${points.join(' L')}`
})()

/** プレミアムの添え。形は変えず、まわりで小さく光るだけ。 */
export function MarkerSparkle() {
  return (
    <g className="hero-tree-sparkle" pointerEvents="none">
      {[
        [10, 16, 12, 0],
        [88, 34, 9.5, 0.6],
        [72, 88, 8, 1.2],
        [30, 4, 7, 1.7],
        [4, 62, 6, 2.1],
        [95, 68, 5, 2.6],
      ].map(([x, y, r, delay]) => (
        <path
          key={`${x}-${y}`}
          style={{ animationDelay: `${delay}s` }}
          d={`M${x} ${y - r}Q${x + r * 0.22} ${y - r * 0.22} ${x + r} ${y}Q${x + r * 0.22} ${y + r * 0.22} ${x} ${y + r}Q${x - r * 0.22} ${y + r * 0.22} ${x - r} ${y}Q${x - r * 0.22} ${y - r * 0.22} ${x} ${y - r}Z`}
          fill="var(--marker-sparkle)"
        />
      ))}
    </g>
  )
}

/**
 * 金の実の光線。中心 (51,59) から8方向へ、長短交互のとがった三角を放つ。
 * 後光の円（半径50）より十分長くないと円に埋もれて見えない。0-100 の箱を
 * はみ出すので、凡例のサンプル svg は overflow-visible にしてある。
 */
const GOLD_RAYS = (() => {
  const [cx, cy] = [51, 59]
  return Array.from({ length: 8 }, (_, index) => {
    const angle = (Math.PI / 4) * index - Math.PI / 2
    const length = index % 2 === 0 ? 85 : 62
    const width = index % 2 === 0 ? 6.5 : 5
    const [dx, dy] = [Math.cos(angle), Math.sin(angle)]
    const [px, py] = [-dy, dx]
    return `M${(cx + px * width).toFixed(1)} ${(cy + py * width).toFixed(1)}L${(cx + dx * length).toFixed(1)} ${(cy + dy * length).toFixed(1)}L${(cx - px * width).toFixed(1)} ${(cy - py * width).toFixed(1)}Z`
  }).join('')
})()

const BERRY_STALK = (
  <path
    d="M50 2v20M50 14q10-5 15-2M50 20q-9-3-13 0"
    stroke="var(--marker-stalk)"
    strokeWidth="3.4"
    fill="none"
    strokeLinecap="round"
  />
)

/** 0-100 のローカル座標で描いた1つぶん。置く側が translate/scale で運ぶ。 */
export function MarkerArt({ kind, urgent = false }: { kind: MarkerKind; urgent?: boolean }): ReactNode {
  switch (kind) {
    case 'ripe':
      return (
        <g className="hero-tree-hang">
          {BERRY_STALK}
          <ellipse cx="36" cy="54" rx="17" ry="18" fill="var(--marker-berry-a)" />
          <ellipse cx="66" cy="47" rx="14" ry="15" fill="var(--marker-berry-b)" />
          <ellipse cx="52" cy="76" rx="15.5" ry="16" fill="var(--marker-berry-c)" />
          <ellipse cx="30" cy="47" rx="5" ry="3.4" fill="#fff" opacity=".38" transform="rotate(-30 30 47)" />
          <ellipse cx="61" cy="41" rx="4" ry="2.8" fill="#fff" opacity=".34" transform="rotate(-30 61 41)" />
        </g>
      )
    case 'gold':
      return (
        <g className="hero-tree-hang">
          {/* 後光。フィルタ無しで柔らかく見せるため、同心円を薄く重ねる —
              blur は置く側の scale と掛かって環境ごとにボケ量が変わる。
              光線はその中でゆっくり回る（.hero-tree-rays）。 */}
          <g className="hero-tree-glow" pointerEvents="none">
            <g className="hero-tree-rays">
              <path d={GOLD_RAYS} fill="var(--marker-gold-glow)" opacity=".62" />
            </g>
            <circle cx="51" cy="59" r="50" fill="var(--marker-gold-glow)" opacity=".28" />
            <circle cx="51" cy="59" r="40" fill="var(--marker-gold-glow)" opacity=".36" />
            <circle cx="51" cy="59" r="31" fill="var(--marker-gold-glow)" opacity=".46" />
            <circle cx="51" cy="59" r="23" fill="var(--marker-sparkle)" opacity=".6" />
          </g>
          {BERRY_STALK}
          <ellipse cx="36" cy="54" rx="17" ry="18" fill="var(--marker-gold-a)" />
          <ellipse cx="66" cy="47" rx="14" ry="15" fill="var(--marker-gold-b)" />
          <ellipse cx="52" cy="76" rx="15.5" ry="16" fill="var(--marker-gold-c)" />
          <ellipse cx="30" cy="46" rx="6" ry="4" fill="#fffbe8" opacity=".82" transform="rotate(-30 30 46)" />
          <ellipse cx="61" cy="40" rx="4.8" ry="3.2" fill="#fffbe8" opacity=".76" transform="rotate(-30 61 40)" />
          <ellipse cx="47" cy="69" rx="4" ry="2.6" fill="#fffbe8" opacity=".55" transform="rotate(-30 47 69)" />
        </g>
      )
    case 'flying':
      return (
        <g className="hero-tree-bob">
          <g className="hero-tree-wing-l">
            <path d="M47 48C29 20 5 24 9 43c3 15 22 16 38 8z" fill="var(--marker-wing-a)" />
            <path d="M47 52C31 76 11 78 13 63c2-12 18-14 34-11z" fill="var(--marker-wing-b)" />
            <circle cx="24" cy="38" r="4.5" fill="var(--marker-wing-dot)" opacity=".8" />
          </g>
          <g className="hero-tree-wing-r">
            <path d="M53 48C71 20 95 24 91 43c-3 15-22 16-38 8z" fill="var(--marker-wing-c)" />
            <path d="M53 52C69 76 89 78 87 63c-2-12-18-14-34-11z" fill="var(--marker-wing-d)" />
            <circle cx="76" cy="38" r="4.5" fill="var(--marker-wing-dot)" opacity=".8" />
          </g>
          <ellipse cx="50" cy="53" rx="4" ry="17" fill="var(--marker-body)" />
          <circle cx="50" cy="35" r="5" fill="var(--marker-body)" />
          <path
            d="M48 32q-6-10-13-13M52 32q6-10 13-13"
            stroke="var(--marker-body)" strokeWidth="2.4" fill="none" strokeLinecap="round"
          />
        </g>
      )
    case 'soon':
      return (
        <g className={urgent ? 'hero-tree-bob is-urgent' : 'hero-tree-bob'}>
          <g className="hero-tree-buzz">
            <ellipse cx="33" cy="36" rx="21" ry="11" fill="var(--marker-wing-blur)" opacity=".6" transform="rotate(-18 33 36)" />
          </g>
          <g className="hero-tree-buzz is-right">
            <ellipse cx="67" cy="36" rx="21" ry="11" fill="var(--marker-wing-blur)" opacity=".6" transform="rotate(18 67 36)" />
          </g>
          <ellipse cx="50" cy="60" rx="23" ry="19" fill={urgent ? 'var(--marker-bee-urgent)' : 'var(--marker-bee)'} />
          <path d="M31 52q19 6 38 0" stroke="var(--marker-body)" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M29 62q21 7 42 0" stroke="var(--marker-body)" strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M34 72q16 6 32 0" stroke="var(--marker-body)" strokeWidth="5.5" fill="none" strokeLinecap="round" />
          <ellipse cx="40" cy="52" rx="8" ry="4" fill="#fff" opacity=".2" transform="rotate(-20 40 52)" />
          <circle cx="50" cy="36" r="11.5" fill="var(--marker-body)" />
          <path
            d="M44 26q-4-8-10-10M56 26q4-8 10-10"
            stroke="var(--marker-body)" strokeWidth="2.4" fill="none" strokeLinecap="round"
          />
          <ellipse cx="50" cy="79" rx="4" ry="6" fill="var(--marker-body)" />
        </g>
      )
    case 'near':
      return (
        <g className="hero-tree-creep">
          <path d="M6 84q0-13 14-13h44q11 0 11 7t-11 7H22q-9 0-9 6z" fill="var(--marker-foot)" />
          <path d="M62 78q7-3 9-12l3-13q1-6 7-5t5 7l-3 14q-4 16-19 18z" fill="var(--marker-foot)" />
          <path
            d="M78 54q0-12-4-18M87 56q5-11 3-18"
            stroke="var(--marker-foot-line)" strokeWidth="3.4" fill="none" strokeLinecap="round"
          />
          <circle cx="73" cy="33" r="3.3" fill="var(--marker-eye)" />
          <circle cx="90" cy="35" r="3.3" fill="var(--marker-eye)" />
          <circle cx="38" cy="50" r="23" fill="var(--marker-shell)" />
          <path d="M38 27a23 23 0 0 1 20 12" stroke="var(--marker-shell-light)" strokeWidth="6" fill="none" strokeLinecap="round" opacity=".7" />
          <path d={SHELL_SPIRAL} fill="none" stroke="var(--marker-shell-dark)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
          <ellipse cx="30" cy="38" rx="7" ry="4.5" fill="#fff" opacity=".22" transform="rotate(-30 30 38)" />
        </g>
      )
    case 'bloom':
      return (
        <g className="hero-tree-sway">
          <path d="M50 100V44" stroke="var(--marker-stem)" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M50 78q-15-4-19-16 15-2 19 12z" fill="var(--marker-leaf-a)" />
          <path d="M50 66q14-5 18-16-14-1-18 12z" fill="var(--marker-leaf-b)" />
          {[0, 60, 120, 180, 240, 300].map((angle) => (
            <ellipse key={angle} cx="50" cy="18" rx="9.5" ry="15" fill="var(--marker-petal)" transform={`rotate(${angle} 50 32)`} />
          ))}
          {[30, 150, 270].map((angle) => (
            <ellipse key={angle} cx="50" cy="20" rx="7.5" ry="12.5" fill="var(--marker-petal-light)" transform={`rotate(${angle} 50 32)`} />
          ))}
          <circle cx="50" cy="32" r="8.5" fill="var(--marker-pollen)" />
          <circle cx="50" cy="32" r="3.8" fill="var(--marker-pollen-dark)" />
        </g>
      )
    case 'gone':
      return (
        <g className="hero-tree-droop">
          <path d="M52 100V56q0-10-8-14" stroke="var(--marker-stem-dry)" strokeWidth="4" strokeLinecap="round" fill="none" />
          <path d="M52 82q-14-5-17-16 14-1 17 12z" fill="var(--marker-leaf-dry-a)" opacity=".85" />
          <path d="M52 70q11-6 13-15-11 0-13 11z" fill="var(--marker-leaf-dry-b)" opacity=".7" />
          <g transform="rotate(-26 44 42)">
            {[0, 60, 120, 180, 240, 300].map((angle) => (
              <ellipse key={angle} cx="44" cy="30" rx="8" ry="13" fill="var(--marker-petal-dry)" transform={`rotate(${angle} 44 42)`} />
            ))}
            <circle cx="44" cy="42" r="7.5" fill="var(--marker-pollen-dry)" />
          </g>
          <ellipse cx="72" cy="96" rx="9" ry="4" fill="var(--marker-petal-dry)" transform="rotate(18 72 96)" opacity=".9" />
          <ellipse cx="30" cy="98" rx="7.5" ry="3.4" fill="var(--marker-petal-dry)" transform="rotate(-24 30 98)" opacity=".8" />
        </g>
      )
    case 'unknown':
      return (
        <g className="hero-tree-creep">
          <path
            d="M28 62q-9 6-14 3M72 62q9 6 14 3M26 50q-10 1-14-3M74 50q10 1 14-3"
            stroke="var(--marker-body)" strokeWidth="3" strokeLinecap="round" fill="none"
          />
          <ellipse cx="50" cy="58" rx="31" ry="28" fill="var(--marker-unknown)" />
          <path d="M50 30a31 28 0 0 0 0 56z" fill="var(--marker-unknown-dark)" />
          <path d="M50 30v56" stroke="var(--marker-body)" strokeWidth="3" />
          <circle cx="37" cy="50" r="5.6" fill="var(--marker-body)" />
          <circle cx="63" cy="50" r="5.6" fill="var(--marker-body)" />
          <circle cx="41" cy="70" r="4.2" fill="var(--marker-body)" />
          <circle cx="59" cy="70" r="4.2" fill="var(--marker-body)" />
          <path d="M50 32a22 14 0 0 1-22-12 22 14 0 0 1 44 0 22 14 0 0 1-22 12z" fill="var(--marker-body)" />
          <path
            d="M40 12q-5-8-11-9M60 12q5-8 11-9"
            stroke="var(--marker-body)" strokeWidth="2.6" fill="none" strokeLinecap="round"
          />
        </g>
      )
  }
}
