/**
 * E-mail input for the login form.
 *
 * One field, the whole address. It used to be a free local part plus a fixed
 * `@example.com` <select>; that pulldown was removed because it made every
 * address outside the demo domains unenterable, and the closed list belongs to
 * registration (`features/signup/accountSchema.ts`), not to sign-in. Login only
 * needs to know the address is well-formed — an address nobody owns is answered
 * by the 401, which deliberately never says which half was wrong.
 */
import type { ReactNode } from 'react'
import { Field } from '../../components/Field'
import { Input } from '@/components/ui/input'
import { EMAIL_MAX_LENGTH } from './validation'

export function EmailField({
  idPrefix,
  label = 'メールアドレス',
  hint,
  value,
  onChange,
  onBlur,
  error,
  disabled = false,
  autoComplete = 'username',
}: {
  idPrefix: string
  label?: string
  hint?: ReactNode
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  error?: string
  disabled?: boolean
  autoComplete?: string
}) {
  const controlId = `${idPrefix}-email`

  return (
    <Field label={label} controlId={controlId} hint={hint} error={error}>
      {({ describedBy }) => (
        <Input
          id={controlId}
          className="w-full"
          /* type="email" so phones get the @ keyboard. Validation stays ours
             (noValidate on the form) — the browser bubble cannot be worded. */
          type="email"
          inputMode="email"
          value={value}
          maxLength={EMAIL_MAX_LENGTH}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          autoComplete={autoComplete}
          disabled={disabled}
          placeholder="taro@example.com"
        />
      )}
    </Field>
  )
}
