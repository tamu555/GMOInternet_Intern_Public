/**
 * Search input: a free-text label only (spec §6.1 検索・空き確認). TLDs are no
 * longer picked here - the page searches every supported TLD automatically
 * and availability is chosen per-TLD on the result table instead.
 *
 * Two variants of the same form:
 *   initial  - the hero search bar shown before any search has run: one white
 *              box with squared corners holding the field and the deep-green
 *              button flush inside it (the pill shape read badly at its corners)
 *   research - the compact bar under the result table ("文字列を変えて再検索")
 *
 * The initial variant keeps the exact accessibility contract the Field
 * wrapper used to provide: an accessible label ("取得したいドメイン名", sr-only
 * because the hero uses placeholder-only styling), aria-describedby wiring to
 * the hint and the error, and role="alert" on the field error.
 */
import type { FormEvent } from 'react'
import { Lightbulb, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { normalizeDomainLabel } from './validation'

export function DomainSearchForm({
  idPrefix,
  variant = 'initial',
  label,
  onLabelChange,
  labelError,
  disabled = false,
  onSubmit,
}: {
  idPrefix: string
  variant?: 'initial' | 'research'
  label: string
  onLabelChange: (value: string) => void
  labelError?: string
  disabled?: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const labelId = `${idPrefix}-domain-label`

  if (variant === 'research') {
    return (
      <form className="space-y-3" onSubmit={onSubmit} noValidate>
        <p className="flex w-fit items-center gap-2 rounded-none bg-accent px-4 py-2 text-sm text-accent-foreground">
          <Lightbulb className="size-4 shrink-0" aria-hidden="true" />
          空いていない場合は、文字列を変えて再検索！
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            id={labelId}
            type="text"
            className="h-10 w-full rounded-md px-4 sm:w-64"
            aria-label="取得したいドメイン名"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            onBlur={(event) => onLabelChange(normalizeDomainLabel(event.target.value))}
            aria-invalid={labelError ? true : undefined}
            disabled={disabled}
            placeholder="my-shop"
          />
          <Button type="submit" size="lg" className="h-10 rounded-md px-6" disabled={disabled}>
            {disabled ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                確認中…
              </>
            ) : (
              '再検索'
            )}
          </Button>
        </div>
        {labelError ? (
          <p className="text-[13px] font-medium text-destructive" role="alert">
            {labelError}
          </p>
        ) : null}
      </form>
    )
  }

  const hintId = `${labelId}-hint`
  const errorId = `${labelId}-error`
  const describedBy = labelError ? `${hintId} ${errorId}` : hintId

  return (
    <form className="w-full max-w-[560px]" onSubmit={onSubmit} noValidate>
      <label htmlFor={labelId} className="sr-only">
        取得したいドメイン名
      </label>
      {/* One white box holding the field and the button — squared corners, no
          border; the soft shadow is what lifts it off the grass band. */}
      <div className="flex flex-wrap gap-1.5 rounded-lg bg-card p-1.5 shadow-soft sm:flex-nowrap">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 sm:pl-4">
          <Search className="size-5 shrink-0 text-grass" aria-hidden="true" />
          <Input
            id={labelId}
            type="text"
            className="h-14 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-base focus-visible:border-0 focus-visible:ring-0 md:text-base"
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            onBlur={(event) => onLabelChange(normalizeDomainLabel(event.target.value))}
            aria-describedby={describedBy}
            aria-invalid={labelError ? true : undefined}
            disabled={disabled}
            placeholder="my-shop"
          />
        </div>
        <Button
          type="submit"
          size="lg"
          className="h-14 w-full shrink-0 rounded-md px-8 font-heading text-[15px] font-bold sm:w-auto"
          disabled={disabled}
        >
          {disabled ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              確認しています…
            </>
          ) : (
            '検索する'
          )}
        </Button>
      </div>
      {labelError ? (
        <p
          id={errorId}
          role="alert"
          className="mt-3 w-fit rounded-md bg-card px-4 py-2 text-[13px] font-medium text-destructive shadow-soft"
        >
          {labelError}
        </p>
      ) : null}
      <p id={hintId} className="mt-3.5 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
        TLD（.com など）は含めず入力してください。全角文字は自動的に半角へ変換されます。
      </p>
    </form>
  )
}
