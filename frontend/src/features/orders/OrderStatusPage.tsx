/**
 * 注文結果画面 (/orders/:orderId, FIG.1 右下の3分岐).
 *
 * Order.state is rendered as FOUR-plus states, never a boolean (spec §5,
 * TBD #17): 処理中 (paid/provisioning) / 再試行中 (retrying) / 完了 (done) /
 * 失敗 (failed). Each has spec-fixed wording (orderMessages.ts):
 *   - retrying: 「処理中です。自動で再試行しています」 + 二重課金しない明示 (§6.7)
 *   - failed:   「処理できませんでした」- the internal refund treatment is
 *               never surfaced (§5)
 *   - done via the backend's 2302 recovery renders as a plain success; the
 *     recovery judgement itself is backend-only (FIG.2) and is NOT
 *     re-implemented here.
 *
 * This screen is addressable by order id, so a reload after payment lands
 * back here instead of re-submitting anything.
 */
import { Link, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBanner } from '../../components/StatusBanner'
import { failureReasonForResultCode, NO_DOUBLE_CHARGE_MESSAGE, ORDER_FAILED_MESSAGE, ORDER_FAILED_NO_CHARGE_MESSAGE, ORDER_NOT_FOUND_MESSAGE, ORDER_STATUS_UNAVAILABLE_MESSAGE, PROVISIONING_MESSAGE, RENEW_PROVISIONING_MESSAGE, RETRY_LATER_MESSAGE, RETRYING_MESSAGE } from './orderMessages'
import { OrderCompletion } from './OrderCompletion'
import { RenewCompletion } from './RenewCompletion'
import { useOrderPolling } from './useOrderPolling'

function ProgressIndicator({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6" role="status">
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

export function OrderStatusPage() {
  const { orderId = '' } = useParams()
  const { order, error } = useOrderPolling(orderId)

  if (error === 'not-found') {
    return (
      <div className="space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">注文状況</h1>
        </header>
        <StatusBanner tone="error">{ORDER_NOT_FOUND_MESSAGE}</StatusBanner>
        <div>
          <Button asChild>
            <Link to="/">ドメイン検索へ戻る</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (error === 'unavailable') {
    return (
      <div className="space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">注文状況</h1>
        </header>
        <StatusBanner tone="error">{ORDER_STATUS_UNAVAILABLE_MESSAGE}</StatusBanner>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="space-y-6">
        <ProgressIndicator message="注文状況を確認しています…" />
      </div>
    )
  }

  if (order.state === 'done' && order.domain) {
    return (
      <div className="space-y-6">
        {/* FIG.10: kind=renew はマイページへ戻す完了画面（DNS誘導は不要）。 */}
        {order.kind === 'renew' ? (
          <RenewCompletion order={order} domain={order.domain} />
        ) : (
          <OrderCompletion order={order} domain={order.domain} />
        )}
      </div>
    )
  }

  if (order.state === 'failed') {
    const reason = failureReasonForResultCode(order.resultCode)
    return (
      <div className="space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">注文状況</h1>
          <p className="font-mono text-sm text-muted-foreground">{order.domainName}</p>
        </header>
        <StatusBanner tone="error">
          {ORDER_FAILED_MESSAGE}
          {reason ? ` ${reason}` : null}
        </StatusBanner>
        <Card>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed">{ORDER_FAILED_NO_CHARGE_MESSAGE}</p>
            <p className="text-sm leading-relaxed">{RETRY_LATER_MESSAGE}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link to="/">ドメイン検索へ戻る</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // paid / provisioning / retrying: still in flight, keep polling.
  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">注文を処理しています</h1>
        <p className="font-mono text-sm text-muted-foreground">{order.domainName}</p>
      </header>

      {order.state === 'retrying' ? (
        <StatusBanner tone="info">
          {RETRYING_MESSAGE} {NO_DOUBLE_CHARGE_MESSAGE}
        </StatusBanner>
      ) : null}

      <Card>
        <CardContent className="space-y-4">
          <ProgressIndicator message={order.kind === 'renew' ? RENEW_PROVISIONING_MESSAGE : PROVISIONING_MESSAGE} />
          {/* Placeholder for the summary that appears once the order settles. */}
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
          <p className="text-center text-sm leading-relaxed text-muted-foreground">
            このページを閉じても処理は続きます。完了までしばらくお待ちください。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
