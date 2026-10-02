/**
 * 「ドメイン名」と「中身のある場所」がまだ結ばれていない、という1枚の絵。
 *
 * ⚠️ 図は装飾（aria-hidden）。同じ意味は必ず本文とキャプションの文字が持つ
 * （CONNECT_MODEL_DIAGRAM_CAPTION）。読み上げ環境では図が無いのと同じになる。
 *
 * 色はテーマトークン由来の fill-* / stroke-* ユーティリティだけを使う。
 * ライト／ダークの出し分けは CSS 変数側で完結するので dark: は書かない
 * （DESIGN_SYSTEM.md）。図中に実ドメイン名は入れない — 長い名前ではみ出す。
 */
export function ConnectDiagram() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 480 128"
      className="h-auto w-full max-w-[480px]"
    >
      <defs>
        <marker
          id="dns-connect-arrowhead"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="4"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" className="fill-primary" />
        </marker>
      </defs>

      {/* 左: ドメイン名（＝住所） */}
      <rect x="2" y="30" width="160" height="68" className="fill-card stroke-border" strokeWidth="1" />
      <text x="82" y="58" textAnchor="middle" className="fill-foreground text-[14px] font-bold">
        ドメイン名
      </text>
      <text x="82" y="80" textAnchor="middle" className="fill-muted-foreground text-[12px]">
        あなたが取った住所
      </text>

      {/* 中央: まだ結ばれていないので破線。矢印はつなぐ向きを示す。 */}
      <text x="240" y="42" textAnchor="middle" className="fill-primary text-[12px] font-bold">
        この画面でつなぐ
      </text>
      <line
        x1="170"
        y1="64"
        x2="302"
        y2="64"
        className="stroke-primary"
        strokeWidth="2"
        strokeDasharray="6 6"
        markerEnd="url(#dns-connect-arrowhead)"
      />

      {/* 右: 中身のある場所（＝サービスのコンピュータ） */}
      <rect x="318" y="30" width="160" height="68" className="fill-card stroke-border" strokeWidth="1" />
      <text x="398" y="58" textAnchor="middle" className="fill-foreground text-[14px] font-bold">
        中身のある場所
      </text>
      <text x="398" y="80" textAnchor="middle" className="fill-muted-foreground text-[12px]">
        サービスのコンピュータ
      </text>
    </svg>
  )
}
