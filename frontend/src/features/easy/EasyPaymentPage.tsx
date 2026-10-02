/**
 * ステップ5: 支払い（/easy/payment）。
 *
 * 決済まわりは通常モードと同じ処理をそのまま使う:
 *   - ペイロード生成 … orderFormModel.buildOrderCreateRequest（常に完全）
 *   - 発注         … ordersApi.createOrder（ペイロード指紋ごとの idempotencyKey）
 *   - 文言         … orderMessages（疑似決済である旨は仕様 §2.2 の固定文言）
 * かんたんモードが変えているのは説明の量とレイアウトだけで、処理は 1 行も
 * 複製していない。
 *
 * ⚠️ 料金表示だけは通常モードの `PriceDisplay` を使わない。あれは「比べて選ぶ」
 * 画面のための部品で、3年間の合計という *いま請求されない* 合計を含む。決済を
 * 確定する画面に別の合計を置くと、押す直前の読み手がどちらが請求額か分からなく
 * なるため、この画面専用に内訳を組み直している（§6.2.5 の並記は維持）。
 */
import { useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { createOrder } from '../../api/ordersApi'
import { useAuth } from '../../auth/useAuth'
import { StatusBanner } from '../../components/StatusBanner'
import { formatYen } from '../domains/tldData'
import { buildInitialPaymentValues, PaymentSection, validatePayment } from '../payments'
import type { PaymentFormErrors, PaymentFormValues } from '../payments'
import {
  buildInitialOrderFormValues,
  buildOrderCreateRequest,
  parseOrderableDomain,
  totalPriceYen,
} from '../orders/orderFormModel'
import { PSEUDO_PAYMENT_NOTICE, messageForOrderCreateError } from '../orders/orderMessages'
import { EasyPageHeader, EasyStepNav } from './EasyStepActions'
import {
  AUTO_RENEW_OFF_NOTE,
  autoRenewOnNote,
  PAYMENT_ACTION,
  PAYMENT_BREAKDOWN_HEADING,
  PAYMENT_HEADING,
  PAYMENT_IN_PROGRESS,
  PAYMENT_LEDE,
  PAYMENT_NEXT_YEARS_TERM,
  paymentChargedLabel,
  TLD_FIRST_YEAR_LABEL,
  TLD_RENEWAL_LABEL,
} from './easyMessages'
import { easyStepDef } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'

/**
 * §6.2.5: 初年度と 2年目以降の金額は必ず同じ文字サイズで並べる。両方がこの 1 つの
 * 定数を参照するので、片方だけ小さくする編集が構造的にできない。
 * ⚠️ Tailwind の JIT はソースに literal で現れたクラスしか生成しないので、
 * この文字列を実行時に加工して別のクラスを作ってはならない。
 */
const PRICE_FIGURE_CLASS = 'font-en text-sm'

export function EasyPaymentPage() {
  const idPrefix = useId()
  const gate = useEasyGate('payment')
  const navigate = useNavigate()
  const { session, recordOrder, setStepError } = useEasy()
  const { state: authState } = useAuth()

  const [payment, setPayment] = useState<PaymentFormValues>(buildInitialPaymentValues)
  const [paymentErrors, setPaymentErrors] = useState<PaymentFormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /* ref で同期的に閉じる。useState はバッチされるのでダブルクリックを止め切れない
     （OrderApplicationPage と同じ判断）。 */
  const paymentInFlight = useRef(false)

  /**
   * §6.2.6 のデフォルトを含む完全な値。authInfo はここで 1 度だけ生成し、
   * 保存はしない（localStorage に機微情報を載せない）。
   */
  const values = useMemo(
    () => ({ ...buildInitialOrderFormValues(), years: session.years, autoRenew: session.autoRenew }),
    [session.years, session.autoRenew],
  )

  if (gate) return gate

  const parsed = parseOrderableDomain(`${session.label}${session.tld}`)
  if (!parsed || !authState.user) return null

  const { domainName, pricing } = parsed
  const total = totalPriceYen(pricing, session.years)

  function handlePaymentChange(next: PaymentFormValues) {
    setPayment(next)
    setPaymentErrors({})
  }

  async function handlePay() {
    if (paymentInFlight.current) return
    const errors = validatePayment(payment)
    setPaymentErrors(errors)
    if (Object.keys(errors).length > 0) return
    paymentInFlight.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const order = await createOrder(buildOrderCreateRequest(domainName, values))
      // 先にセッションへ記録してから遷移する。ここでリロードされても、次回は
      // 注文済みとして DNS 設定に復帰でき、二重注文にならない。
      recordOrder(order.id, domainName)
      setStepError('payment', null)
      // replace: 「戻る」で再送信できる支払い画面に着地させない。
      navigate(easyStepDef('dns').path, { replace: true })
    } catch (error) {
      const message = messageForOrderCreateError(error)
      setSubmitError(message)
      setStepError('payment', message)
      paymentInFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <EasyStepNav backTo={easyStepDef('confirm').path} />

      <EasyPageHeader title={PAYMENT_HEADING} lede={PAYMENT_LEDE} />

      {submitError ? <StatusBanner tone="error">{submitError}</StatusBanner> : null}

      {/* ⚠️ カードに「お支払いの内容」の見出しを付けない。ページ見出しの
          「お支払い」と同じことを言っているだけで、読む行が 1 本増える。 */}
      <Card>
        <CardContent className="space-y-4">
          <dl>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <dt className="text-sm text-muted-foreground">何に</dt>
              <dd className="text-sm font-medium">
                <span className="font-mono">{domainName}</span> の取得（{session.years}年分）
              </dd>
            </div>
          </dl>
          {/* ⚠️ この画面に出してよい合計は「いま請求される額」だけ。参照用の内訳に
              3年間の合計のような別の合計を混ぜると、支払う直前の読み手が、より
              太く見える方の金額を請求額だと受け取る（監査 2026-08-27）。
              請求額の帯は確認画面とまったく同じ形にしてある — 同じ金額を「いくら」の
              行と帯の 2 か所に出すと、どちらが請求額かを読み直させることになる。 */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-grass-2 px-3 py-3">
            <span className="text-sm font-medium">{paymentChargedLabel(session.years)}</span>
            <strong className="font-en text-xl font-bold text-green-darkest">{formatYen(total)}</strong>
          </div>

          <section className="space-y-2 bg-grass-1/60 px-3 py-3">
            <h3 className="text-sm font-medium">{PAYMENT_BREAKDOWN_HEADING}</h3>
            <dl className="space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-muted-foreground">{TLD_FIRST_YEAR_LABEL}</dt>
                <dd className={PRICE_FIGURE_CLASS}>{formatYen(pricing.firstYearYen)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-sm text-muted-foreground">{TLD_RENEWAL_LABEL}</dt>
                <dd className={PRICE_FIGURE_CLASS}>{formatYen(pricing.renewalYearYen)}</dd>
              </div>
            </dl>
          </section>

          {/* 継続課金への同意を取れるのはこの画面だけ。金額と止め方をここで言う。 */}
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{PAYMENT_NEXT_YEARS_TERM}</p>
            <p className="text-sm leading-relaxed">
              {session.autoRenew ? autoRenewOnNote(formatYen(pricing.renewalYearYen)) : AUTO_RENEW_OFF_NOTE}
            </p>
          </div>

          <PaymentSection
            variant="plain"
            idPrefix={idPrefix}
            values={payment}
            errors={paymentErrors}
            onChange={handlePaymentChange}
            disabled={submitting}
          />

          <StatusBanner tone="info">{PSEUDO_PAYMENT_NOTICE}</StatusBanner>
          <Button type="button" size="lg" className="w-full sm:w-auto" onClick={() => void handlePay()} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                {PAYMENT_IN_PROGRESS}
              </>
            ) : (
              PAYMENT_ACTION
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
