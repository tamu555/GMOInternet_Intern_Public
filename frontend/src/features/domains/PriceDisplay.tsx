/**
 * Pricing display (spec §6.2.5): "初年度 ◯円 / 2年目以降 毎年 ◯円" must be
 * shown in the SAME font size - both figures share the `text-sm` row class,
 * so a single class is the one place that invariant can break, not two.
 */
import { formatYen, threeYearTotalYen, type TldPricing } from './tldData'

export function PriceDisplay({ pricing }: { pricing: TldPricing }) {
  return (
    <dl className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <dt className="text-muted-foreground">初年度</dt>
        <dd>{formatYen(pricing.firstYearYen)}</dd>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <dt className="text-muted-foreground">2年目以降 毎年</dt>
        <dd>{formatYen(pricing.renewalYearYen)}</dd>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-border pt-2 text-sm font-semibold">
        <dt>3年間の合計</dt>
        <dd>{formatYen(threeYearTotalYen(pricing))}</dd>
      </div>
    </dl>
  )
}
