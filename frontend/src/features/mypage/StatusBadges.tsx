/**
 * §3.5 status chips: colour + label together, never colour alone (色覚多様性
 * 対応). Unknown statuses pass through verbatim via labelForDomainStatus.
 * The autoRenewPeriod RGP status (§3.6/§6.4) gets its own spec-worded chip.
 */
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { labelForDomainStatus } from '../domains/domainStatusLabels'
import { daysUntil, STATUS_TONE_CLASSES } from './domainDisplay'

export function StatusBadges({
  statuses,
  rgpStatuses = [],
  autoRenewCancelableUntil,
}: {
  statuses: string[]
  rgpStatuses?: string[]
  autoRenewCancelableUntil?: string
}) {
  return (
    <>
      {statuses.map((status) => {
        const { label, tone } = labelForDomainStatus(status)
        return (
          <Badge key={status} variant="outline" className={STATUS_TONE_CLASSES[tone]}>
            {label}
          </Badge>
        )
      })}
      {rgpStatuses.includes('autoRenewPeriod') ? (
        <Badge variant="outline" className={STATUS_TONE_CLASSES.pending}>
          <RefreshCw />
          自動で1年延びました
          {autoRenewCancelableUntil ? `（取り消すなら残り${daysUntil(autoRenewCancelableUntil)}日）` : null}
        </Badge>
      ) : null}
    </>
  )
}
