/**
 * Validation schema for step 3 契約者情報 (zod v4).
 *
 * The business (会社名/屋号/部署名/担当者名) fields are optional at the type
 * level and enforced by superRefine whenever 契約者種別 != 個人 (individual),
 * so switching the radio never leaves stale "required" errors behind on
 * hidden fields. Sole-proprietor reuses the exact same corporate field
 * requirements - only the UI label for `companyName` changes (会社名 vs 屋号),
 * the schema field name and its rules stay identical.
 *
 * This is also reused as-is for the Google additional-info form
 * (additionalInfoSchema.ts): the full profile minus email/password is
 * exactly what this schema already validates.
 */
import { z } from 'zod'
import { addressSchema } from './addressSchema'
import {
  KANA_FORMAT_MESSAGE,
  KANA_OR_LATIN_HAS_LETTER,
  KANA_OR_LATIN_PATTERN,
  NAME_KANA_LABEL,
  NAME_LABEL,
  NAME_MAX_LENGTH,
} from './nameRules'

export { PREFECTURES } from './addressSchema'

/** 0始まり10〜11桁、ハイフン任意 (例: 090-1234-5678). Japan-only; other countries accept any non-empty value. */
const JP_PHONE_PATTERN = /^0\d{1,4}-?\d{1,4}-?\d{3,4}$/

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export const GENDERS = [
  { value: 'male', label: '男性' },
  { value: 'female', label: '女性' },
  { value: 'other', label: 'その他' },
  { value: 'no_answer', label: '回答しない' },
] as const

/** Field bounds mirror the backend's profileSchema.ts (security review: name/kana ≤100, phone ≤20, business fields ≤200). */
const PHONE_MAX = 20
const BUSINESS_FIELD_MAX = 200

/**
 * Same Y/M/D round-trip check as the backend's `profileSchema.ts`
 * `superRefine` (functions/src/auth/profileSchema.ts): `new Date(...)`
 * silently rolls an invalid date like "1990-02-30" over to "1990-03-02"
 * instead of rejecting it, so validity has to be confirmed by reconstructing
 * the date from its parts and comparing them back, not just checking
 * `!Number.isNaN(parsed.getTime())`.
 */
function isValidPastCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const isRealCalendarDate =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  return isRealCalendarDate && parsed.getTime() <= Date.now()
}

export const contractSchema = z
  .object({
    accountType: z.enum(['individual', 'sole-proprietor', 'corporate']),
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
    companyName: z.string().trim().max(BUSINESS_FIELD_MAX, `会社名は${BUSINESS_FIELD_MAX}文字以内で入力してください。`).optional(),
    department: z.string().trim().max(BUSINESS_FIELD_MAX, `部署名は${BUSINESS_FIELD_MAX}文字以内で入力してください。`).optional(),
    contactPerson: z.string().trim().max(NAME_MAX_LENGTH, `担当者名は${NAME_MAX_LENGTH}文字以内で入力してください。`).optional(),
    phoneNumber: z
      .string()
      .trim()
      .min(1, '電話番号を入力してください。')
      .max(PHONE_MAX, `電話番号は${PHONE_MAX}文字以内で入力してください。`),
    dateOfBirth: z
      .string()
      .trim()
      .min(1, '生年月日を入力してください。')
      .regex(DATE_PATTERN, '生年月日の形式で入力してください（例: 1990-01-01）。')
      .refine(isValidPastCalendarDate, '正しい生年月日を入力してください。'),
    gender: z.enum(['male', 'female', 'other', 'no_answer']),
    newsletterOptIn: z.boolean(),
    address: addressSchema,
  })
  .superRefine((values, ctx) => {
    const requiresBusiness = values.accountType !== 'individual'
    const companyNameLabel = values.accountType === 'sole-proprietor' ? '屋号' : '会社名'
    if (requiresBusiness && !values.companyName) {
      ctx.addIssue({ code: 'custom', path: ['companyName'], message: `${companyNameLabel}を入力してください。` })
    }
    if (requiresBusiness && !values.contactPerson) {
      ctx.addIssue({ code: 'custom', path: ['contactPerson'], message: '担当者名を入力してください。' })
    }
    // Japan's phone format is strict; other countries only require non-empty
    // (no invented international regex - see the feature's architecture doc).
    if (values.address.country === 'JP' && !JP_PHONE_PATTERN.test(values.phoneNumber)) {
      ctx.addIssue({
        code: 'custom',
        path: ['phoneNumber'],
        message: '電話番号の形式で入力してください（例: 090-1234-5678）。',
      })
    }
  })

export type ContractFormValues = z.infer<typeof contractSchema>
