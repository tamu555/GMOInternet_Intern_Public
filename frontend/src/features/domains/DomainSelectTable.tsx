/**
 * Per-TLD availability grid (docs/api-flow-diagrams.html FIG.1).
 *
 * Layout = お名前.com's result table: one CELL per TLD, stacked as
 * 「TLD名 / 料金 / 空き状況」, laid out as a band of cells rather than a band of
 * text rows. The searched label is not repeated in every cell (it is printed
 * once, above the grid, by DomainSearchPage) - exactly as お名前.com does it -
 * so the cells stay narrow enough to line up as a scannable band. The full
 * domain is still in the DOM for assistive tech (`sr-only`) and in every
 * button's accessible name.
 *
 * EVERY supported TLD is on the page at once. お名前.com pages its own grid at
 * 12 TLDs a band and hides the rest behind 前へ / 次へ; we deliberately do NOT
 * copy that. The cheapest TLD of the whole catalogue (.icu / .cyou) and the
 * only ones a user might still get after ".com が埋まっていた" would sit one
 * unnoticed click away while the search looked like a failure. A search that
 * always spans every TLD (see DomainSearchPage) must also *show* every TLD, so
 * the grid wraps (`auto-fill`) instead of paging.
 *
 * The sort control is the one thing the お名前.com grid has no equivalent of,
 * and it is the reason the grid is safe to use here: 初年度が安い順 /
 * 更新が安い順 re-order the cells, so a price comparison that a fixed
 * registry-ordered band would hide is one click away.
 *
 * 初年度 and 更新 share ONE class (`PRICE_LINE*`) = one font size (spec
 * §6.2.5): the renewal price - the one that is usually the higher of the two -
 * can never be rendered quieter than the first-year teaser price. Both figures
 * stay in the cell; showing only the teaser (as a bare お名前.com cell does)
 * would break that rule.
 *
 * Distinct states, never collapsed (spec §6.7): a TLD whose registry could not
 * be reached renders as "？ 確認できませんでした", never as "✕ 使用中" -
 * collapsing this would tell the user a domain they could actually get is
 * unavailable. A TLD no registry serves at all ("unsupported") renders as "−"
 * so a backend/UI catalogue drift shows up honestly instead of as a
 * transient-looking "？". A TLD whose registry is JUDGED unreachable (503s
 * sustained ~1min, docs/仕様/registry-unavailable.md §5.3) renders as
 * "⏳ 一時購入不可" — listed but not purchasable, and deliberately not
 * called maintenance. Each state pairs a glyph with words, never colour
 * alone, and the non-selectable ones keep their `role="img"` +
 * `aria-label`.
 */
import { useId, useMemo, useState, type ReactNode } from 'react'
import { Bell, Check } from 'lucide-react'
import type { DomainSearchResultItem } from '../../api/domainsSearchApi'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { formatYen, getTldMeta, getTldPricingOrDefault, type TldPricing } from './tldData'

/** The one shared class of both price figures — one font size (spec §6.2.5). */
const PRICE_LINE = 'block font-en text-[15px] leading-6 font-semibold tabular-nums'
/** Fixed boxes so 初年度 / 更新 line up in a column across every row. */
const PRICE_LABEL = 'inline-block w-[3.4em] text-[11px] font-normal text-ink-faint'
const PRICE_AMOUNT = 'inline-block min-w-[4.6em] text-right'

/** The same two lines inside a grid cell: centred, so no fixed label box. */
const PRICE_LINE_COMPACT = 'block font-en text-[12.5px] leading-[1.5] font-semibold tabular-nums'
const PRICE_LABEL_COMPACT = 'text-[10.5px] font-normal text-ink-faint'

/**
 * One band of TLD cells. `auto-fill` + a 112px floor is what replaces
 * お名前.com's fixed 12-per-page band: the widest cell content
 * (「初年度 ¥7,980」) still fits at the floor, and the band simply wraps to a
 * second line instead of hiding the tail behind a pager.
 */
export const TLD_GRID = 'grid list-none grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2.5 p-0'

/**
 * The chrome of one TLD cell, as four classes rather than one component.
 *
 * かんたんモード's step 3 shows the same band of cells (EasyTldPage), but its
 * cells carry a radio instead of a cart toggle and cannot sit inside `<li>`
 * (they live under one `role="radiogroup"`). Sharing the CLASSES rather than
 * the markup is what keeps the two grids looking identical without forcing the
 * easy-mode grid into this component's `<li>` shell — restyle a cell here and
 * both modes move together.
 */
export const TLD_CELL_SHELL = 'flex h-full flex-col overflow-hidden rounded-lg border text-center shadow-soft'
export const TLD_CELL_SHELL_SELECTED = 'border-green-brand bg-grass-1'
export const TLD_CELL_SHELL_IDLE = 'border-border bg-card'
export const TLD_CELL_HEAD = 'font-en px-1.5 py-1.5 text-[13.5px] leading-5 font-semibold tracking-tight'
export const TLD_CELL_HEAD_ACTIVE = 'bg-grass-2 text-green-darkest'
export const TLD_CELL_HEAD_MUTED = 'bg-status-locked-bg text-status-locked-fg'
export const TLD_CELL_PRICE = 'border-b border-border bg-paper-2 px-1 py-1.5'
export const TLD_CELL_FOOT = 'flex flex-1 items-center justify-center px-1.5 py-2'

/**
 * 「おすすめ順」は 2026-08-27 に廃止した。並び替えを一切しておらず（検索APIが
 * 返した順＝実質アルファベット順をそのまま出していた）、根拠のない「おすすめ」
 * を名乗っていたため。並び替えは価格の2軸だけにし、既定は初年度が安い順。
 * 目的にもとづく本物の推薦は、かんたんモード（purposeTldPriority.ts）が持つ。
 */
type SortKey = 'firstYear' | 'renewal'

const SORTS: Array<{ key: SortKey; text: string }> = [
  { key: 'firstYear', text: '初年度が安い順' },
  { key: 'renewal', text: '更新が安い順' },
]

type Row = {
  result: DomainSearchResultItem
  pricing: TldPricing | undefined
  caveat: string | undefined
  /** The registry order — the fallback ranking of every sort. */
  order: number
}

type StateView = {
  glyph: string
  text: string
  tone: string
  /** Set for the states that are not a control: they announce themselves. */
  ariaLabel?: string
}

function describeState(result: DomainSearchResultItem): StateView {
  if (result.state === 'available') {
    return { glyph: '◯', text: '空きあり', tone: 'text-green-brand' }
  }
  if (result.state === 'taken') {
    return {
      glyph: '✕',
      text: '使用中',
      tone: 'text-destructive',
      ariaLabel: `${result.domain} は使用中`,
    }
  }
  if (result.state === 'unavailable') {
    // Deliberately not the transient-looking "？": the registry has been
    // judged unreachable, so the TLD stays listed but cannot be purchased
    // right now — without claiming maintenance
    // (docs/仕様/registry-unavailable.md §5.3).
    return {
      glyph: '⏳',
      text: '一時購入不可',
      tone: 'text-muted-foreground',
      ariaLabel: `${result.domain} はレジストリに接続できないため一時的に購入できません`,
    }
  }
  if (result.state === 'maintenance') {
    // The registry announced this window itself (poll queue), so unlike ⏳
    // the wording may say メンテナンス (docs/仕様/registry-unavailable.md).
    return {
      glyph: '🔧',
      text: 'メンテナンス中',
      tone: 'text-muted-foreground',
      ariaLabel: `${result.domain} はレジストリがメンテナンス中のため購入できません`,
    }
  }
  if (result.unknownReason === 'unsupported') {
    return {
      glyph: '−',
      text: '取り扱いなし',
      tone: 'text-muted-foreground',
      ariaLabel: `${result.domain} は取り扱いのないTLDです`,
    }
  }
  return {
    glyph: '？',
    text: '確認できませんでした',
    tone: 'text-muted-foreground',
    ariaLabel: `${result.domain} は確認できませんでした`,
  }
}

/** Unpriced TLDs sort last rather than first (0 would look like the cheapest). */
function priceRank(pricing: TldPricing | undefined, key: 'firstYearYen' | 'renewalYearYen'): number {
  return pricing ? pricing[key] : Number.POSITIVE_INFINITY
}

function sortRows(rows: Row[], sort: SortKey): Row[] {
  const key = sort === 'firstYear' ? 'firstYearYen' : 'renewalYearYen'
  return [...rows].sort(
    (a, b) => priceRank(a.pricing, key) - priceRank(b.pricing, key) || a.order - b.order,
  )
}

/**
 * The two price figures of one TLD. Exported so the landing page's 結果見本 can
 * show the exact same two lines it will show after a search - a sample that
 * typesets prices differently from the real result list is a promise the
 * result list then breaks. `compact` is the in-grid variant: smaller and
 * centred, but still ONE class for both lines (spec §6.2.5).
 */
export function PriceLines({ pricing, compact = false }: { pricing: TldPricing | undefined; compact?: boolean }) {
  const line = compact ? PRICE_LINE_COMPACT : PRICE_LINE
  const label = compact ? PRICE_LABEL_COMPACT : PRICE_LABEL
  const amount = compact ? '' : PRICE_AMOUNT

  if (!pricing) return <span className={line}>—</span>
  return (
    <>
      <span className={line}>
        <span className={label}>初年度</span> <span className={amount}>{formatYen(pricing.firstYearYen)}</span>
      </span>
      <span className={line}>
        <span className={label}>更新</span> <span className={amount}>{formatYen(pricing.renewalYearYen)}</span>
      </span>
    </>
  )
}

/**
 * The chrome of one TLD cell: 名前 → 料金 → 空き状況, top to bottom.
 *
 * Exported for the same reason `PriceLines` is: the landing page's 結果見本 must
 * show the exact cell the result grid will show, or the sample is a promise the
 * result grid then breaks.
 *
 * The cell is one flex column with `h-full`, so the price strip and the status
 * strip of every cell in a band line up even when a TLD has no price (「—」) or
 * a longer status word (「確認できませんでした」). `status` is the bottom strip:
 * a toggle button when the domain can be selected, an announced glyph when it
 * cannot.
 */
export function TldCell({
  tld,
  domain,
  pricing,
  caveat,
  selected = false,
  muted = false,
  status,
}: {
  tld: string
  /** The full domain — carried for assistive tech; the cell only prints the TLD. */
  domain: string
  pricing: TldPricing | undefined
  caveat?: string
  selected?: boolean
  /** Not selectable: the header and the prices step back rather than invite a click. */
  muted?: boolean
  status: ReactNode
}) {
  return (
    <li className="h-full">
      <div
        className={`${TLD_CELL_SHELL} ${selected ? TLD_CELL_SHELL_SELECTED : TLD_CELL_SHELL_IDLE}`}
      >
        {/* The cells only carry the TLD (お名前.com does the same); the label
            being searched is printed once above the grid. Assistive tech gets
            the whole domain here, and again in the button's accessible name. */}
        <span className="sr-only">{domain}</span>

        <div className={`${TLD_CELL_HEAD} ${muted ? TLD_CELL_HEAD_MUTED : TLD_CELL_HEAD_ACTIVE}`}>
          {tld}
          {caveat ? (
            <span aria-hidden="true" className="text-ink-faint">
              ※
            </span>
          ) : null}
        </div>

        <div className={`${TLD_CELL_PRICE} ${muted ? 'text-ink-faint' : ''}`}>
          <PriceLines pricing={pricing} compact />
        </div>

        <div className={TLD_CELL_FOOT}>{status}</div>
      </div>
    </li>
  )
}

/** The two-line status glyph of a TLD that cannot be selected (spec §6.7). */
function StateMark({ state }: { state: StateView }) {
  return (
    <span role="img" aria-label={state.ariaLabel} className={`block ${state.tone}`}>
      <span aria-hidden="true" className="block text-[17px] leading-5">
        {state.glyph}
      </span>
      <span aria-hidden="true" className="block text-[11px] leading-tight font-bold text-balance">
        {state.text}
      </span>
    </span>
  )
}

/**
 * The states a watch may be registered on: the name exists but cannot be
 * bought right now. `unknown` is deliberately absent — "確認できませんでした"
 * is a communication failure, not a fact about the name, so offering a watch
 * there would promise something the backend cannot check either.
 */
const WATCHABLE_STATES: DomainSearchResultItem['state'][] = [
  'taken',
  'unavailable',
  'maintenance',
]

/**
 * 空いたら通知 (docs/仕様/domain-watch.md): the alternative this screen
 * offers instead of a purchase on an unbuyable name. Nothing is charged and
 * nothing is reserved — the backend re-checks and マイページ tells the member
 * when the name is confirmed free.
 */
function WatchControl({
  domain,
  watched,
  onWatch,
}: {
  domain: string
  watched: boolean
  onWatch: (domain: string) => void
}) {
  if (watched) {
    return (
      <span className="flex items-center gap-1 text-[11px] font-bold text-green-brand">
        <Check aria-hidden="true" className="size-3.5" />
        空き待ち登録済み
      </span>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-auto gap-1 rounded-md px-2 py-1 text-[11px] leading-tight"
      aria-label={`${domain} が購入できるようになったら通知を受け取る`}
      onClick={() => onWatch(domain)}
    >
      <Bell aria-hidden="true" className="size-3.5" />
      空いたら通知
    </Button>
  )
}

function ResultCell({
  row,
  selected,
  onToggle,
  watched,
  onWatch,
}: {
  row: Row
  selected: boolean
  onToggle: (domain: string) => void
  watched: boolean
  onWatch?: (domain: string) => void
}) {
  const { result, pricing, caveat } = row
  const state = describeState(result)
  const selectable = result.state === 'available'
  const watchable = onWatch !== undefined && WATCHABLE_STATES.includes(result.state)

  return (
    <TldCell
      tld={result.tld}
      domain={result.domain}
      pricing={pricing}
      caveat={caveat}
      selected={selected}
      muted={!selectable}
      status={
        selectable ? (
          <Button
            type="button"
            variant={selected ? 'default' : 'outline'}
            size="sm"
            className="h-auto w-full flex-col gap-0.5 rounded-md px-1 py-1.5 leading-tight"
            aria-pressed={selected}
            aria-label={`${result.domain} を選択`}
            onClick={() => onToggle(result.domain)}
          >
            {selected ? (
              <Check aria-hidden="true" className="size-4.5" />
            ) : (
              <span aria-hidden="true" className="text-[17px] leading-5 text-green-brand">
                {state.glyph}
              </span>
            )}
            <span className="text-[11px] font-bold">{selected ? '選択中' : '選択する'}</span>
          </Button>
        ) : watchable ? (
          <span className="flex flex-col items-center gap-1.5">
            <StateMark state={state} />
            <WatchControl domain={result.domain} watched={watched} onWatch={onWatch} />
          </span>
        ) : (
          <StateMark state={state} />
        )
      }
    />
  )
}

function GroupHeading({ text, tone }: { text: string; tone: string }) {
  return <h3 className={`pt-1 text-[13px] font-bold ${tone}`}>{text}</h3>
}

export function DomainSelectTable({
  results,
  selected,
  onToggle,
  watched = [],
  onWatch,
}: {
  results: DomainSearchResultItem[]
  selected: string[]
  onToggle: (domain: string) => void
  /** Domains the member already watches (空き待ち登録済み). */
  watched?: string[]
  /** When set, unbuyable cells offer 「空いたら通知」. */
  onWatch?: (domain: string) => void
}) {
  const selectedSet = new Set(selected)
  const watchedSet = new Set(watched)
  const onlyAvailableId = useId()
  const [sort, setSort] = useState<SortKey>('firstYear')
  const [onlyAvailable, setOnlyAvailable] = useState(false)

  const rows = useMemo<Row[]>(
    () =>
      results.map((result, order) => ({
        result,
        // OrDefault: a TLD the live registry list serves but the local price
        // table does not must still quote the price the backend will charge,
        // not a dead "—" on a selectable cell.
        pricing: getTldPricingOrDefault(result.tld),
        caveat: getTldMeta(result.tld)?.caveat,
        order,
      })),
    [results],
  )

  // 空きあり first, always: those are the cells that can be acted on. The sort
  // control then orders each band, so "初年度が安い順" never buries a free
  // TLD under a cheaper one that is already taken.
  const available = useMemo(
    () => sortRows(rows.filter((row) => row.result.state === 'available'), sort),
    [rows, sort],
  )
  const unavailable = useMemo(
    () => sortRows(rows.filter((row) => row.result.state !== 'available'), sort),
    [rows, sort],
  )

  const caveats = rows.filter((row): row is Row & { caveat: string } => Boolean(row.caveat))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="並び替え">
          <span className="text-[13px] text-muted-foreground">並び替え</span>
          {SORTS.map((option) => (
            <Button
              key={option.key}
              type="button"
              variant={sort === option.key ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 px-3 text-[13px]"
              aria-pressed={sort === option.key}
              onClick={() => setSort(option.key)}
            >
              {option.text}
            </Button>
          ))}
        </div>

        {unavailable.length > 0 ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={onlyAvailableId}
              checked={onlyAvailable}
              onCheckedChange={(checked) => setOnlyAvailable(checked === true)}
            />
            <Label htmlFor={onlyAvailableId} className="text-[13px] font-normal">
              空きのみ表示
            </Label>
          </div>
        ) : null}
      </div>

      {available.length > 0 ? (
        <>
          <GroupHeading text={`◯ 空きあり（${available.length}件）`} tone="text-green-brand" />
          <ul className={TLD_GRID}>
            {available.map((row) => (
              <ResultCell
                key={row.result.tld}
                row={row}
                selected={selectedSet.has(row.result.domain)}
                onToggle={onToggle}
                watched={watchedSet.has(row.result.domain)}
                onWatch={onWatch}
              />
            ))}
          </ul>
        </>
      ) : null}

      {unavailable.length > 0 && !onlyAvailable ? (
        <>
          <GroupHeading text={`選択できないTLD（${unavailable.length}件）`} tone="text-ink-faint" />
          <ul className={TLD_GRID}>
            {unavailable.map((row) => (
              <ResultCell
                key={row.result.tld}
                row={row}
                selected={selectedSet.has(row.result.domain)}
                onToggle={onToggle}
                watched={watchedSet.has(row.result.domain)}
                onWatch={onWatch}
              />
            ))}
          </ul>
        </>
      ) : null}

      {available.length === 0 && onlyAvailable ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          空きのあるTLDはありませんでした。「空きのみ表示」を外すと、確認したすべてのTLDを表示します。
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        ◯ 空きあり（クリックで選択） ／ ✕ すでに使われています ／ ？ 確認できませんでした
        {results.some((result) => result.state === 'unavailable')
          ? ' ／ ⏳ 一時的に購入できません（レジストリ接続不能）'
          : null}
        {results.some((result) => result.state === 'maintenance')
          ? ' ／ 🔧 レジストリのメンテナンス中です'
          : null}
        {results.some((result) => result.unknownReason === 'unsupported') ? ' ／ − 取り扱いのないTLDです' : null}
        ／ 料金はすべて税込・1年あたりです。
      </p>

      {onWatch && unavailable.some((row) => WATCHABLE_STATES.includes(row.result.state)) ? (
        <p className="text-xs text-muted-foreground">
          いま購入できないドメインは「空いたら通知」を登録しておくと、購入できる状態を確認でき次第マイページでお知らせします（料金はかかりません）。
        </p>
      ) : null}

      {caveats.length > 0 ? (
        <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          {caveats.map((row) => (
            <li key={row.result.tld}>
              ※ <strong className="font-mono font-semibold">{row.result.tld}</strong> — {row.caveat}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
