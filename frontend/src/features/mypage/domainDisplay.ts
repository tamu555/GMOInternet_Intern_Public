/**
 * Presentation helpers for the my-page screens (FIG.9-10).
 *
 * Colour NEVER carries meaning alone (§3.5 色覚多様性対応): every tone class
 * here is rendered next to the label text from domainStatusLabels.ts.
 *
 * NOTE (§7.1): remaining days are computed against the real clock for now; the
 * spec's "表示用の基準時刻" (mock clock) should be injected here once it
 * exists - this module is the single place that would change.
 */
import type { DomainStatusTone } from '../domains/domainStatusLabels'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Calendar days from `from` to `isoDate`, ignoring the time of day.
 *
 * The registry's exDate strings arrive in mixed shapes (date-only, ISO with
 * no timezone, ISO with Z), so comparing raw timestamps with Math.ceil made
 * the count depend on the viewing hour (off-by-one before 09:00 JST for
 * date-only values, which parse as UTC midnight). Truncating both sides to
 * the local calendar day gives the same answer at any hour. Math.round (not
 * ceil) so a partial day introduced by the truncated timezone offset can
 * never add a day.
 */
export function daysUntil(isoDate: string, from: Date = new Date()): number {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOfDay(new Date(isoDate)) - startOfDay(from)) / DAY_MS)
}

/**
 * RGP (RFC 3915) の復旧猶予ステータス。両レジストリとも delete でこれが付き、
 * これが付いている間だけ restore が通る（45日）。外れたあとの pendingDelete
 * 単独は復旧不可（2304）で、数日後に抹消される.
 */
const REDEMPTION_PERIOD = 'redemptionPeriod'

/**
 * 「いま復旧できるか」。status / rgpStatus の両方を見るのは、レジストリの
 * 文書が redemptionPeriod の置き場所について食い違っているため（本文の表は
 * status、DomainResponse.rgpStatus の説明は別レイヤ）。片方だけを見ると、
 * どちらの読みが正しいかで復旧ボタンの有無が変わってしまう.
 *
 * 期限（restorableUntil）を過ぎたものも復旧不可として扱う: バックエンドが
 * まだ status を取り直していない間に、確実に失敗する操作を勧めないため.
 */
export function canRestore(
  domain: { statuses: string[]; rgpStatuses?: string[]; restorableUntil?: string },
  from: Date = new Date(),
): boolean {
  const inRedemption =
    domain.statuses.includes(REDEMPTION_PERIOD) ||
    (domain.rgpStatuses ?? []).includes(REDEMPTION_PERIOD)
  if (!inRedemption) return false
  if (!domain.restorableUntil) return true
  return new Date(domain.restorableUntil).getTime() > from.getTime()
}

/**
 * 残り日数の表示用。0未満は返さない — 「あと-2日は戻せます」は日付計算の
 * ズレをそのまま画面に出してしまうため、0日（＝今日まで）に丸める.
 */
export function daysLeftUntil(isoDate: string, from: Date = new Date()): number {
  return Math.max(0, daysUntil(isoDate, from))
}

export function formatDateJa(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long' }).format(date)
}

export function formatDateTimeJa(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** 残り期間バー (§6.4): share of a one-year term still remaining, 0-100. */
export function expiryProgressPercent(exDate: string, from: Date = new Date()): number {
  const remaining = daysUntil(exDate, from)
  return Math.max(0, Math.min(100, Math.round((remaining / 365) * 100)))
}

/** Bar colour thresholds; the day count is always printed next to the bar. */
export function expiryIndicatorClass(remainingDays: number): string {
  if (remainingDays <= 30) return 'bg-destructive'
  if (remainingDays <= 90) return 'bg-orange-strong'
  return 'bg-primary'
}

/**
 * §3.5 の表示色（案）: 緑 / グレー / 青 / 橙〜赤 / 黄 / 青グレー.
 * All colours come from tokens in styles/app.css (brand palette + the
 * status-* tokens) so dark mode flips via prefers-color-scheme with no
 * dark: utilities (DESIGN_SYSTEM.md).
 */
export const STATUS_TONE_CLASSES: Record<DomainStatusTone, string> = {
  ok: 'border-transparent bg-grass-1 text-green-deep',
  inactive: 'border-transparent bg-secondary text-muted-foreground',
  pending: 'border-transparent bg-status-info-bg text-status-info-fg',
  ending: 'border-transparent bg-orange-soft text-orange-strong',
  hold: 'border-transparent bg-status-hold-bg text-status-hold-fg',
  locked: 'border-transparent bg-status-locked-bg text-status-locked-fg',
  neutral: 'border-transparent bg-secondary text-muted-foreground',
}

export const REGISTRY_LABELS: Record<string, string> = {
  kitaqsign: 'Kitaqsign',
  kitaqnic: 'Kitaqnic',
}
