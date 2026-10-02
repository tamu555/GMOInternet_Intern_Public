/**
 * 更新ダイアログ (FIG.10 RENEW): 期間選択 + 料金 → POST /api/orders
 * (kind=renew). Payment/retry/no-double-charge reuse the FIG.1 order contract;
 * this dialog only collects the years and hands off to /orders/{id}.
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { formatYen, getTldPricingOrDefault } from '../domains/tldData'
import { REGISTRATION_YEAR_OPTIONS } from '../orders/orderDefaults'
import { buildInitialPaymentValues, PaymentSection, validatePayment } from '../payments'
import type { PaymentFormErrors, PaymentFormValues } from '../payments'
import { daysUntil, formatDateJa } from './domainDisplay'
import { MULTI_YEAR_RENEWAL_HINT } from './mypageMessages'

function plusYears(isoDate: string, years: number): string {
  const date = new Date(isoDate)
  date.setFullYear(date.getFullYear() + years)
  return date.toISOString()
}

type RenewDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  domainName: string
  exDate: string
  busy: boolean
  onSubmit: (years: number) => void
}

export function RenewDialog({ open, onOpenChange, ...bodyProps }: RenewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix unmounts DialogContent while closed, so the body (years +
          payment state) remounts clean on every open (same pattern as
          RetireDialog) — a cancelled attempt never leaks into the next one. */}
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <RenewDialogBody onOpenChange={onOpenChange} {...bodyProps} />
      </DialogContent>
    </Dialog>
  )
}

function RenewDialogBody({
  onOpenChange,
  domainName,
  exDate,
  busy,
  onSubmit,
}: Omit<RenewDialogProps, 'open'>) {
  const idPrefix = useId()
  const [years, setYears] = useState<number>(1)
  const [payment, setPayment] = useState<PaymentFormValues>(buildInitialPaymentValues)
  const [paymentErrors, setPaymentErrors] = useState<PaymentFormErrors>({})
  const tld = domainName.slice(domainName.indexOf('.'))
  // OrDefault: a domain on a TLD outside the local price table must still be
  // renewable, at the price the backend will actually charge.
  const pricing = getTldPricingOrDefault(tld)
  const totalYen = pricing.renewalYearYen * years
  const newExDate = plusYears(exDate, years)

  function handlePaymentChange(next: PaymentFormValues) {
    setPayment(next)
    setPaymentErrors({})
  }

  function handleSubmit() {
    const errors = validatePayment(payment)
    setPaymentErrors(errors)
    if (Object.keys(errors).length > 0) return
    onSubmit(years)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>期限を更新する</DialogTitle>
        <DialogDescription>
          <span className="font-mono font-semibold">{domainName}</span> の有効期限を延長します（現在:{' '}
          {formatDateJa(exDate)} / 残り{daysUntil(exDate)}日）。
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          更新期間
          <select
            className="h-10 rounded-md border border-input bg-card px-3 text-sm font-normal"
            value={years}
            disabled={busy}
            onChange={(event) => setYears(Number(event.target.value))}
          >
            {REGISTRATION_YEAR_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}年
              </option>
            ))}
          </select>
        </label>
        {/* §6.4: 複数年更新の提案 */}
        <p className="text-xs text-muted-foreground">{MULTI_YEAR_RENEWAL_HINT}</p>

        <Separator />

        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">更新料</dt>
            <dd className="font-semibold">
              {`${formatYen(pricing.renewalYearYen)} × ${years}年`}
            </dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">お支払い合計（疑似決済）</dt>
            <dd className="text-base font-bold">{formatYen(totalYen)}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">新しい有効期限</dt>
            <dd className="font-semibold">{formatDateJa(newExDate)}</dd>
          </div>
        </dl>

        <Separator />

        {/* columns={1}: the dialog is `sm:max-w-md`, but the selector's own
            `sm:` breakpoint reads the VIEWPORT — left at 2, every method label
            wraps mid-word inside a half-width column on a desktop screen. */}
        <PaymentSection
          variant="plain"
          columns={1}
          idPrefix={idPrefix}
          values={payment}
          errors={paymentErrors}
          onChange={handlePaymentChange}
          disabled={busy}
        />
      </div>

      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
          キャンセル
        </Button>
        <Button disabled={busy} onClick={handleSubmit}>
          {busy ? '処理中…' : '支払って更新する'}
        </Button>
      </DialogFooter>
    </>
  )
}
