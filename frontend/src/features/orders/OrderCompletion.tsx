/**
 * 完了画面 (FIG.1 DONE node): acquired domain, expiry, statuses, masked
 * authInfo (§7.3), then the DNS-settings hand-off FIG.1 ends with.
 *
 * An order that reached "done" through the backend's 2302 recovery (FIG.2 /
 * §6.7) renders EXACTLY like any other success - "this was actually a retry"
 * is internal bookkeeping the user never sees.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CircleCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Order, OrderedDomain } from '../../api/ordersApi'
import { StatusBanner } from '../../components/StatusBanner'
import { labelForDomainStatus, type DomainStatusTone } from '../domains/domainStatusLabels'
import { AuthInfoMasked } from './AuthInfoMasked'
import { INACTIVE_DOMAIN_NOTICE } from './orderMessages'

function formatExDate(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long' }).format(date)
}

/** §3.5: colour never carries the meaning alone - the label text is always shown. */
const TONE_BADGE_VARIANTS: Record<DomainStatusTone, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ok: 'default',
  inactive: 'secondary',
  neutral: 'secondary',
  pending: 'secondary',
  locked: 'outline',
  hold: 'outline',
  ending: 'destructive',
}

function InfoRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

export function OrderCompletion({ order, domain }: { order: Order; domain: OrderedDomain }) {
  const isUnpublished = domain.statuses.includes('inactive')

  return (
    <>
      <header className="space-y-1.5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-none bg-accent">
            <CircleCheck className="size-5 text-primary" aria-hidden="true" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">ドメインを取得しました</h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <strong className="font-mono text-foreground">{domain.name}</strong>{' '}
          はあなたのドメインになりました。
        </p>
      </header>

      {isUnpublished ? <StatusBanner tone="info">{INACTIVE_DOMAIN_NOTICE}</StatusBanner> : null}

      <Card>
        <CardHeader>
          <CardTitle>ドメイン情報</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-border">
            <InfoRow term="ドメイン名">
              <span className="font-mono">{domain.name}</span>
            </InfoRow>
            <InfoRow term="有効期限">{formatExDate(domain.exDate)}</InfoRow>
            <InfoRow term="ステータス">
              {/* Colour + label, never colour alone (§3.5 色覚多様性対応). */}
              <span className="flex flex-wrap justify-end gap-1.5">
                {domain.statuses.map((status) => {
                  const { label, tone } = labelForDomainStatus(status)
                  return (
                    <Badge key={status} variant={TONE_BADGE_VARIANTS[tone]}>
                      {label}
                    </Badge>
                  )
                })}
              </span>
            </InfoRow>
            <InfoRow term="自動更新">{order.autoRenew ? 'ON' : 'OFF'}</InfoRow>
            <InfoRow term="認証コード（authInfo）">
              <AuthInfoMasked authInfo={domain.authInfo} />
              <p className="mt-1.5 text-[13px] leading-relaxed font-normal text-muted-foreground">
                他社への移管時に使用します。第三者には知られないようにしてください。
              </p>
            </InfoRow>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>次のステップ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {isUnpublished
              ? 'ネームサーバ（DNS）の設定をすると、このドメインでWebサイトやメールを使えるようになります。'
              : 'DNSレコードを設定して、Webサイトやメールでこのドメインを使い始めましょう。'}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link to={`/domains/${encodeURIComponent(domain.name)}/dns`}>DNS設定に進む</Link>
            </Button>
            {/* FIG.9: 完了画面 → 取得したドメインの管理（マイページ詳細）へ */}
            <Button variant="outline" asChild>
              <Link to={`/mypage/domains/${encodeURIComponent(domain.name)}`}>マイページで管理する</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
