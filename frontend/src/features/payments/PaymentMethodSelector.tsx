/**
 * Radio-card group for choosing one of the 8 dummy payment methods.
 *
 * Mirrors the existing `RecommendedTldCard` pattern
 * (`features/easy/EasyTldPage.tsx`) rather than inventing a new card shape:
 * a `Label` wraps both the `RadioGroupItem` and the row content, the card is
 * `bg-card` / `shadow-soft` at rest and swaps to `bg-grass-1` when selected
 * (never a border/ring). Selection is conveyed by more than color: the
 * RadioGroupItem's own checked dot (native `role="radio"` state, announced by
 * screen readers) plus the fill.
 */
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'
import { PAYMENT_SECTION_HEADING } from './paymentMessages'
import { PAYMENT_METHOD_CATALOG } from './paymentMethods'
import type { PaymentMethodId } from './paymentTypes'

function PaymentMethodCard({
  controlId,
  label,
  summary,
  icon: Icon,
  value,
  selected,
  disabled,
}: {
  controlId: string
  label: string
  summary: string
  icon: (typeof PAYMENT_METHOD_CATALOG)[number]['icon']
  value: PaymentMethodId
  selected: boolean
  disabled?: boolean
}) {
  return (
    <div className={cn('flex h-full flex-col gap-2 p-4 shadow-soft transition-colors', selected ? 'bg-grass-1' : 'bg-card')}>
      <Label htmlFor={controlId} className="flex cursor-pointer items-start gap-3">
        <RadioGroupItem id={controlId} value={value} disabled={disabled} className="mt-1" aria-label={label} />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <span className="flex items-center gap-2 text-[15px] font-bold">
            <Icon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            {label}
          </span>
          <span className="text-sm text-muted-foreground">{summary}</span>
        </span>
      </Label>
    </div>
  )
}

export function PaymentMethodSelector({
  idPrefix,
  value,
  onChange,
  disabled,
  columns = 2,
}: {
  idPrefix: string
  value: PaymentMethodId | null
  onChange: (method: PaymentMethodId) => void
  disabled?: boolean
  /**
   * Widest column count on `sm:` and up. The breakpoint is the VIEWPORT, not
   * this component's own width, so a caller that renders inside a narrow
   * container on a wide screen (the 更新ダイアログ, `sm:max-w-md`) must pass 1 —
   * otherwise every method label wraps mid-word inside a half-width column.
   */
  columns?: 1 | 2
}) {
  return (
    <RadioGroup
      aria-label={PAYMENT_SECTION_HEADING}
      value={value ?? ''}
      onValueChange={(next) => onChange(next as PaymentMethodId)}
      // ⚠️ Literal class strings only — Tailwind's JIT never sees a class name
      // that is assembled at runtime.
      className={cn('grid grid-cols-1 gap-2.5', columns === 2 && 'sm:grid-cols-2')}
    >
      {PAYMENT_METHOD_CATALOG.map((option) => (
        <PaymentMethodCard
          key={option.id}
          controlId={`${idPrefix}-method-${option.id}`}
          label={option.label}
          summary={option.summary}
          icon={option.icon}
          value={option.id}
          selected={value === option.id}
          disabled={disabled}
        />
      ))}
    </RadioGroup>
  )
}
