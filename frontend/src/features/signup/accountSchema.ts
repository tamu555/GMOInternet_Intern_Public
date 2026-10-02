/**
 * Validation schema for step 1 アカウント作成 (zod v4).
 * One schema per screen on purpose - the screens stay independently
 * maintainable and the confirm screen never re-validates what a previous
 * screen already guaranteed.
 */
import { z } from 'zod'
import { ALLOWED_EMAIL_DOMAINS } from '../auth/constants'
import {
  KANA_FORMAT_MESSAGE,
  KANA_OR_LATIN_HAS_LETTER,
  KANA_OR_LATIN_PATTERN,
  NAME_KANA_LABEL,
  NAME_LABEL,
  NAME_MAX_LENGTH,
} from './nameRules'

export const PASSWORD_MIN_LENGTH = 8
/** Mirrors the backend's profileSchema.ts/registration.ts bounds (security review). */
const PASSWORD_MAX_LENGTH = 128
const EMAIL_MAX_LENGTH = 254

/**
 * Spec 3.4 restricts the domain (the local part is free), and the backend
 * rejects anything else with a generic `invalid-argument`. Checking it here
 * turns that opaque 400 on the 確認 screen into a field-level error on the
 * screen that owns the input.
 */
const ALLOWED_EMAIL_DOMAIN_MESSAGE = `メールアドレスは ${ALLOWED_EMAIL_DOMAINS.map((domain) => `@${domain}`).join(' / ')} のみ利用できます。`

function hasAllowedEmailDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase()
  return ALLOWED_EMAIL_DOMAINS.some((allowed) => allowed === domain)
}

export const accountSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, `${NAME_LABEL}を入力してください。`)
      .max(NAME_MAX_LENGTH, `${NAME_LABEL}は${NAME_MAX_LENGTH}文字以内で入力してください。`),
    nameKana: z
      .string()
      .trim()
      .min(1, `${NAME_KANA_LABEL}を入力してください。`)
      .max(NAME_MAX_LENGTH, `${NAME_KANA_LABEL}は${NAME_MAX_LENGTH}文字以内で入力してください。`)
      .regex(KANA_OR_LATIN_PATTERN, KANA_FORMAT_MESSAGE)
      .regex(KANA_OR_LATIN_HAS_LETTER, KANA_FORMAT_MESSAGE),
    email: z
      .string()
      .trim()
      .min(1, 'メールアドレスを入力してください。')
      .max(EMAIL_MAX_LENGTH, `メールアドレスは${EMAIL_MAX_LENGTH}文字以内で入力してください。`)
      .pipe(z.email('メールアドレスの形式で入力してください。'))
      .refine(hasAllowedEmailDomain, ALLOWED_EMAIL_DOMAIN_MESSAGE),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください。`)
      .max(PASSWORD_MAX_LENGTH, `パスワードは${PASSWORD_MAX_LENGTH}文字以内で入力してください。`),
    passwordConfirm: z.string().min(1, '確認のためパスワードをもう一度入力してください。'),
    agreeTerms: z.boolean().refine((agreed) => agreed, '利用規約への同意が必要です。'),
  })
  .refine((values) => values.password === values.passwordConfirm, {
    path: ['passwordConfirm'],
    message: 'パスワードが一致しません。',
  })

export type AccountFormValues = z.infer<typeof accountSchema>
