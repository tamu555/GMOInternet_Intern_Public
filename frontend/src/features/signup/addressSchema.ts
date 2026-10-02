/**
 * Shared country-conditional address schema (zod v4), used by both the
 * signup wizard's 契約者情報 step (contractSchema.ts) and the Google
 * additional-info screen (additionalInfoSchema.ts). Mirrors the backend's
 * `addressInputSchema` (functions/src/auth/profileSchema.ts) field-for-field:
 * Japan gets its own shape (prefecture/addressLine/building), every other
 * supported country shares an international shape (state/addressLine1/
 * addressLine2).
 */
import { z } from 'zod'
import { INTERNATIONAL_COUNTRY_CODES } from './countries'

export const PREFECTURES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const

/** 123-4567 or 1234567. */
const JP_POSTAL_CODE_PATTERN = /^\d{3}-?\d{4}$/

/**
 * Optional address lines (建物名 / 州・省 / 住所2行目) stay plain strings here
 * (empty string = "not provided"), NOT `.transform()`ed to `string | null`:
 * a zod `.transform()` makes the schema's input/output types diverge, which
 * breaks `@hookform/resolvers`' `zodResolver` generic inference against an
 * explicit `useForm<ContractFormValues>()` (every FormField's `control` type
 * stops matching). The empty-string -> `null` conversion for the wire
 * payload happens once, at the API boundary (signupApi.ts's
 * `toRegistrationPayload`), not in the form schema.
 */
/** Mirrors the backend's `profileSchema.ts` free-text bounds (security review: "address lines ≤200"). */
const ADDRESS_LINE_MAX = 200

const japanAddressSchema = z.object({
  country: z.literal('JP'),
  postalCode: z
    .string()
    .trim()
    .min(1, '郵便番号を入力してください。')
    .regex(JP_POSTAL_CODE_PATTERN, '郵便番号の形式で入力してください（例: 100-0001）。'),
  // Tightened to match the backend's z.enum(JAPAN_PREFECTURES) - the UI only
  // ever offers a <select> of these 47 values anyway, so this closes the
  // schema gap without changing any real user-facing behavior. Kept as a
  // `.refine()` over `z.string()` rather than `z.enum()` outright so the
  // inferred type stays `string` (not a 47-literal union) - `z.enum()` would
  // reject `EMPTY_ADDRESS`'s `''` placeholder default at the TYPE level,
  // even though '' is correctly rejected at the VALIDATION level either way.
  prefecture: z
    .string()
    .trim()
    .min(1, '都道府県を選択してください。')
    .refine((value) => (PREFECTURES as readonly string[]).includes(value), '都道府県を選択してください。'),
  city: z.string().trim().min(1, '市区町村を入力してください。').max(ADDRESS_LINE_MAX, `市区町村は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
  addressLine: z.string().trim().min(1, '番地を入力してください。').max(ADDRESS_LINE_MAX, `番地は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
  building: z.string().trim().max(ADDRESS_LINE_MAX, `建物名は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
})

const internationalAddressSchema = z.object({
  country: z.enum(INTERNATIONAL_COUNTRY_CODES),
  postalCode: z
    .string()
    .trim()
    .min(1, '郵便番号を入力してください。')
    .max(20, '郵便番号は20文字以内で入力してください。'),
  state: z.string().trim().max(ADDRESS_LINE_MAX, `州・省は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
  city: z.string().trim().min(1, '市区町村を入力してください。').max(ADDRESS_LINE_MAX, `市区町村は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
  addressLine1: z.string().trim().min(1, '住所を入力してください。').max(ADDRESS_LINE_MAX, `住所は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
  addressLine2: z.string().trim().max(ADDRESS_LINE_MAX, `住所2行目は${ADDRESS_LINE_MAX}文字以内で入力してください。`),
})

export const addressSchema = z.discriminatedUnion('country', [japanAddressSchema, internationalAddressSchema])

export type AddressFormValues = z.infer<typeof addressSchema>
export type JapanAddressFormValues = z.infer<typeof japanAddressSchema>
export type InternationalAddressFormValues = z.infer<typeof internationalAddressSchema>
