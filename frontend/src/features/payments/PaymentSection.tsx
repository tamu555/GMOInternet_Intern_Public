/**
 * Public entry point for the dummy (疑似) payment feature. Fully controlled —
 * holds no state of its own — so any of the three purchase screens can drop
 * it in unchanged: heading + lede + the mandatory dummy-payment notice +
 * method selector + (once a method is chosen) that method's fields + a
 * low-emphasis "ダミー値を入力" shortcut.
 */
import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBanner } from '@/components/StatusBanner'
import { PaymentMethodFields } from './PaymentMethodFields'
import { PaymentMethodSelector } from './PaymentMethodSelector'
import { buildDummyPaymentValues } from './paymentModel'
import { DUMMY_PAYMENT_INPUT_NOTICE, FILL_DUMMY_ACTION, PAYMENT_SECTION_HEADING, PAYMENT_SECTION_LEDE } from './paymentMessages'
import type { PaymentFormErrors, PaymentFormValues, PaymentMethodId } from './paymentTypes'

function PaymentSectionBody({
  values,
  errors,
  onChange,
  idPrefix,
  disabled,
  columns,
}: {
  values: PaymentFormValues
  errors: PaymentFormErrors
  onChange: (next: PaymentFormValues) => void
  idPrefix: string
  disabled?: boolean
  columns?: 1 | 2
}) {
  function handleMethodChange(method: PaymentMethodId) {
    onChange({ ...values, method })
  }

  function handleFillDummy() {
    if (!values.method) return
    onChange(buildDummyPaymentValues(values.method))
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground leading-relaxed">{PAYMENT_SECTION_LEDE}</p>

      <StatusBanner tone="info">{DUMMY_PAYMENT_INPUT_NOTICE}</StatusBanner>

      {errors.method ? <StatusBanner tone="error">{errors.method}</StatusBanner> : null}

      <PaymentMethodSelector
        idPrefix={idPrefix}
        value={values.method}
        onChange={handleMethodChange}
        disabled={disabled}
        columns={columns}
      />

      {values.method ? (
        <div className="space-y-3">
          <PaymentMethodFields idPrefix={idPrefix} values={values} errors={errors} onChange={onChange} disabled={disabled} />
          <Button type="button" variant="ghost" size="sm" onClick={handleFillDummy} disabled={disabled}>
            {FILL_DUMMY_ACTION}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function PaymentSection({
  values,
  errors,
  onChange,
  idPrefix,
  disabled,
  variant = 'card',
  columns,
}: {
  values: PaymentFormValues
  errors: PaymentFormErrors
  onChange: (next: PaymentFormValues) => void
  idPrefix: string
  disabled?: boolean
  /**
   * 'card' wraps the section in a `Card` (default, for full pages).
   * 'plain' renders with no `Card` wrapper for the 更新ダイアログ, which already
   * supplies its own container.
   */
  variant?: 'card' | 'plain'
  /**
   * Method-card columns on `sm:` and up (default 2). Pass 1 when the caller's
   * own container is narrower than the viewport — see `PaymentMethodSelector`.
   */
  columns?: 1 | 2
}): ReactElement {
  const body = (
    <PaymentSectionBody
      values={values}
      errors={errors}
      onChange={onChange}
      idPrefix={idPrefix}
      disabled={disabled}
      columns={columns}
    />
  )

  if (variant === 'plain') {
    return (
      <div className="space-y-3">
        <h3 className="font-heading text-base leading-snug font-medium">{PAYMENT_SECTION_HEADING}</h3>
        {body}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{PAYMENT_SECTION_HEADING}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  )
}
