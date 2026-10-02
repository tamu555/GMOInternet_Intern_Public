/**
 * PaymentSection is fully controlled, so these tests drive it through a thin
 * stateful harness that mirrors how a real purchase screen would wire it up.
 */
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentSection } from './PaymentSection'
import { buildInitialPaymentValues, isPaymentComplete, validatePayment } from './paymentModel'
import { CARD_NUMBER_LABEL, PAYMENT_METHOD_REQUIRED_ERROR } from './paymentMessages'
import type { PaymentFormValues } from './paymentTypes'

afterEach(cleanup)

function Harness({ initial }: { initial?: PaymentFormValues }) {
  const [values, setValues] = useState<PaymentFormValues>(initial ?? buildInitialPaymentValues())
  const errors = validatePayment(values)
  return <PaymentSection idPrefix="payment-test" values={values} errors={errors} onChange={setValues} />
}

describe('PaymentSection: initial render', () => {
  it('shows the heading and every payment method as a selectable radio', () => {
    render(<Harness />)
    expect(screen.getByText('お支払い方法')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /クレジットカード/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /PayPal/ })).toBeInTheDocument()
  })

  it('renders a passed-in method error with role="alert"', () => {
    render(
      <PaymentSection
        idPrefix="payment-test"
        values={buildInitialPaymentValues()}
        errors={{ method: PAYMENT_METHOD_REQUIRED_ERROR }}
        onChange={() => undefined}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(PAYMENT_METHOD_REQUIRED_ERROR)
  })
})

describe('PaymentSection: choosing a method', () => {
  it('reveals the credit-card fields once クレジットカード is selected', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    expect(screen.queryByLabelText(CARD_NUMBER_LABEL)).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /クレジットカード/ }))

    expect(screen.getByLabelText(CARD_NUMBER_LABEL)).toBeInTheDocument()
    expect(screen.getByLabelText('有効期限')).toBeInTheDocument()
    expect(screen.getByLabelText('セキュリティコード')).toBeInTheDocument()
    expect(screen.getByLabelText('カード名義')).toBeInTheDocument()
  })

  it('switches fields when a different method is chosen afterwards', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('radio', { name: /クレジットカード/ }))
    expect(screen.getByLabelText(CARD_NUMBER_LABEL)).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /^PayPal/ }))
    expect(screen.queryByLabelText(CARD_NUMBER_LABEL)).not.toBeInTheDocument()
    expect(screen.getByLabelText('PayPalアカウント（メールアドレス）')).toBeInTheDocument()
  })
})

describe('PaymentSection: ダミー値を入力', () => {
  it('fills the selected method with values that satisfy isPaymentComplete', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(next: PaymentFormValues) => void>()

    function Wrapper() {
      const [values, setValues] = useState<PaymentFormValues>(buildInitialPaymentValues())
      return (
        <PaymentSection
          idPrefix="payment-test"
          values={values}
          errors={validatePayment(values)}
          onChange={(next) => {
            onChange(next)
            setValues(next)
          }}
        />
      )
    }

    render(<Wrapper />)

    await user.click(screen.getByRole('radio', { name: /コンビニ決済/ }))
    await user.click(screen.getByRole('button', { name: 'ダミー値を入力' }))

    const latest = onChange.mock.calls.at(-1)?.[0]
    expect(latest && isPaymentComplete(latest)).toBe(true)
  })
})
