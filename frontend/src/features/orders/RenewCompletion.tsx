/**
 * 更新注文 (kind=renew, FIG.10) の完了画面。取得完了 (OrderCompletion) とは
 * 別物: DNS設定への誘導は不要で、マイページの詳細へ戻すのが正しい導線。
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { Order, OrderedDomain } from '../../api/ordersApi'
import { formatYen } from '../domains/tldData'

function formatExDate(isoDate: string): string {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long' }).format(date)
}

function InfoRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

export function RenewCompletion({ order, domain }: { order: Order; domain: OrderedDomain }) {
  return (
    <>
      <header className="space-y-1.5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-none bg-accent">
            <CircleCheck className="size-5 text-primary" aria-hidden="true" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">更新が完了しました</h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <strong className="font-mono text-foreground">{domain.name}</strong>{' '}
          の有効期限を延長しました。
        </p>
      </header>

      <Card>
        <CardContent>
          <dl className="divide-y divide-border">
            <InfoRow term="ドメイン名">
              <span className="font-mono">{domain.name}</span>
            </InfoRow>
            <InfoRow term="新しい有効期限">{formatExDate(domain.exDate)}</InfoRow>
            <InfoRow term="更新期間">{order.years}年</InfoRow>
            <InfoRow term="お支払い金額（疑似決済）">{formatYen(order.priceYen)}</InfoRow>
          </dl>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link to={`/mypage/domains/${encodeURIComponent(domain.name)}`}>ドメインの管理へ戻る</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/mypage">マイページへ</Link>
        </Button>
      </div>
    </>
  )
}
