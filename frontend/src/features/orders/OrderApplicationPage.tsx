/**
 * 申込フォーム + 疑似決済 (docs/api-flow-diagrams.html FIG.1 右半分, /domains/new).
 *
 * Entry: the search result CTA links here with ?domain=<label><tld>. Two steps
 * on one route:
 *   input   - every §6.2.6 field, pre-filled with its default. Advanced fields
 *             are FOLDED ("くわしい設定"), not hidden (spec §1.2: normal mode
 *             たたむ; only easy mode masks by not rendering). A validation
 *             error inside the fold force-opens it - a folded field may never
 *             block submission invisibly.
 *   confirm - summary + pseudo payment (spec §2.2: no real billing; no real
 *             payment details are ever collected). "支払う" fires
 *             POST /api/orders once and replaces the history entry with
 *             /orders/{id}, so neither reload nor multi-click can create a
 *             second order.
 */
import { useId, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { createOrder } from '../../api/ordersApi'
import { useAuth } from '../../auth/useAuth'
import { StatusBanner } from '../../components/StatusBanner'
import { PriceDisplay } from '../domains/PriceDisplay'
import { formatYen } from '../domains/tldData'
import { buildInitialPaymentValues, PaymentSection, validatePayment } from '../payments'
import type { PaymentFormErrors, PaymentFormValues } from '../payments'
import {
  AuthInfoField,
  AutoRenewField,
  ContactRolesSection,
  NameserverSection,
  RegistrationYearsField,
} from './OrderFormSections'
import { generateAuthInfo } from './orderDefaults'
import {
  buildInitialOrderFormValues,
  buildOrderCreateRequest,
  parseOrderableDomain,
  totalPriceYen,
  validateOrderForm,
  type OrderFormErrors,
  type OrderFormValues,
} from './orderFormModel'
import { messageForOrderCreateError, PSEUDO_PAYMENT_NOTICE } from './orderMessages'

type Step = 'input' | 'confirm'

function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{term}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

export function OrderApplicationPage() {
  const idPrefix = useId()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { state: authState } = useAuth()

  const parsed = parseOrderableDomain(searchParams.get('domain'))

  const [step, setStep] = useState<Step>('input')
  const [values, setValues] = useState<OrderFormValues>(buildInitialOrderFormValues)
  const [fieldErrors, setFieldErrors] = useState<OrderFormErrors>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [payment, setPayment] = useState<PaymentFormValues>(buildInitialPaymentValues)
  const [paymentErrors, setPaymentErrors] = useState<PaymentFormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Ref, not state: React batches state updates, so a double click could pass
  // a `submitting`-state check twice. The ref flips synchronously.
  const paymentInFlight = useRef(false)

  function updateValue<K extends keyof OrderFormValues>(key: K, value: OrderFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  if (!parsed) {
    return (
      <div className="space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">申込フォーム</h1>
        </header>
        <StatusBanner tone="error">
          申し込むドメインを特定できませんでした。検索画面から「申し込む」を選び直してください。
        </StatusBanner>
        <div>
          <Button asChild>
            <Link to="/">ドメイン検索へ戻る</Link>
          </Button>
        </div>
      </div>
    )
  }

  // RequireAuth admits only settled-authenticated sessions, so user is present.
  const user = authState.user
  if (!user) return null

  function goToConfirm() {
    const errors = validateOrderForm(values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      // Both fields that can error live inside the fold - open it so the
      // error is visible (a hidden validation failure is the §1.2 accident).
      setAdvancedOpen(true)
      return
    }
    setSubmitError(null)
    setStep('confirm')
  }

  function handlePaymentChange(next: PaymentFormValues) {
    setPayment(next)
    setPaymentErrors({})
  }

  async function handlePay() {
    if (paymentInFlight.current || !parsed) return
    const errors = validatePayment(payment)
    setPaymentErrors(errors)
    if (Object.keys(errors).length > 0) return
    paymentInFlight.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const order = await createOrder(buildOrderCreateRequest(parsed.domainName, values))
      // replace: going "back" must not land on a re-submittable payment screen.
      navigate(`/orders/${order.id}`, { replace: true })
    } catch (error) {
      setSubmitError(messageForOrderCreateError(error))
      paymentInFlight.current = false
      setSubmitting(false)
    }
  }

  const { domainName, pricing } = parsed

  if (step === 'confirm') {
    return (
      <div className="space-y-6">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">お申し込み内容の確認</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            内容をご確認のうえ、お支払いに進んでください。
          </p>
        </header>

        {submitError ? <StatusBanner tone="error">{submitError}</StatusBanner> : null}

        <Card>
          <CardHeader>
            <CardTitle>お申し込み内容</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border">
              <SummaryRow term="ドメイン名">
                <span className="font-mono">{domainName}</span>
              </SummaryRow>
              <SummaryRow term="登録期間">{values.years}年</SummaryRow>
              <SummaryRow term="自動更新">
                {values.autoRenew ? 'ON（期限が近づくと自動で更新）' : 'OFF'}
              </SummaryRow>
              <SummaryRow term="ネームサーバ">
                {values.nameserverMode === 'none'
                  ? '設定しない（取得後にDNS設定画面から設定できます）'
                  : values.customNameservers.filter((ns) => ns.trim()).join(' / ')}
              </SummaryRow>
              <SummaryRow term="登録者・admin・tech・billing">
                {user.displayName}（{user.email}）
              </SummaryRow>
            </dl>
          </CardContent>
        </Card>

        <PaymentSection
          idPrefix={idPrefix}
          values={payment}
          errors={paymentErrors}
          onChange={handlePaymentChange}
          disabled={submitting}
        />

        <Card>
          <CardHeader>
            <CardTitle>お支払い金額</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PriceDisplay pricing={pricing} />
            <p className="text-sm">
              今回のお支払い（{values.years}年分）：
              <strong className="ml-1 text-base font-bold">
                {formatYen(totalPriceYen(pricing, values.years))}
              </strong>
            </p>
            <StatusBanner tone="info">{PSEUDO_PAYMENT_NOTICE}</StatusBanner>
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="outline" onClick={() => setStep('input')} disabled={submitting}>
                入力に戻る
              </Button>
              <Button type="button" onClick={() => void handlePay()} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    処理中…
                  </>
                ) : (
                  '支払う（疑似決済）'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">申込フォーム</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <strong className="font-mono text-foreground">{domainName}</strong>{' '}
          を取得します。標準ではおすすめの設定が入っています。
        </p>
      </header>

      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          goToConfirm()
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>基本設定</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <RegistrationYearsField idPrefix={idPrefix} value={values.years} onChange={(years) => updateValue('years', years)} />
            <AutoRenewField
              idPrefix={idPrefix}
              checked={values.autoRenew}
              onChange={(autoRenew) => updateValue('autoRenew', autoRenew)}
            />
            <PriceDisplay pricing={pricing} />
            <p className="text-sm">
              今回のお支払い（{values.years}年分）：
              <strong className="ml-1 text-base font-bold">
                {formatYen(totalPriceYen(pricing, values.years))}
              </strong>
            </p>
          </CardContent>
        </Card>

        <Card className="gap-0 py-0">
          {/* 「隠す」より「たたむ」(spec §1.2): the fields stay part of this form
              and of the payload; only their visibility folds. */}
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-t-xl px-4 py-3.5 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            くわしい設定
            <ChevronDown
              className={cn('size-4 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')}
              aria-hidden="true"
            />
          </button>

          {advancedOpen ? (
            <div className="space-y-5 border-t border-border px-4 py-4">
              <NameserverSection
                idPrefix={idPrefix}
                mode={values.nameserverMode}
                onModeChange={(mode) => updateValue('nameserverMode', mode)}
                customNameservers={values.customNameservers}
                onCustomNameserverChange={(index, value) => {
                  const next: [string, string] = [...values.customNameservers]
                  next[index] = value
                  updateValue('customNameservers', next)
                }}
                error={fieldErrors.customNameservers}
              />
              <AuthInfoField
                idPrefix={idPrefix}
                value={values.authInfo}
                onChange={(authInfo) => updateValue('authInfo', authInfo)}
                onRegenerate={() => updateValue('authInfo', generateAuthInfo())}
                error={fieldErrors.authInfo}
              />
              <ContactRolesSection
                idPrefix={idPrefix}
                user={user}
                sameAsRegistrant={values.contactsSameAsRegistrant}
                onSameAsRegistrantChange={(checked) => updateValue('contactsSameAsRegistrant', checked)}
              />
            </div>
          ) : (
            <p className="border-t border-border px-4 py-3.5 text-sm leading-relaxed text-muted-foreground">
              ネームサーバは設定せずに取得します（あとからDNS設定画面で設定できます）。認証コード（authInfo）・コンタクト情報は、おすすめの設定を自動で使用します。
            </p>
          )}
        </Card>

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <Link to="/">検索へ戻る</Link>
          </Button>
          <Button type="submit">確認画面へ進む</Button>
        </div>
      </form>
    </div>
  )
}
