import {z} from "zod";

const JAPAN_PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

const SUPPORTED_INTL_COUNTRIES = ["US", "GB", "CN", "KR", "TW"] as const;

/*
 * Characters allowed in nameKana.
 *
 * ⚠️ Katakana-only used to lock members without a kanji/kana name (foreign
 * residents) out of registration entirely, so Latin script is accepted too.
 * A-Za-z alone would pass English names while still rejecting French, German
 * and Vietnamese ones, so the accented ranges are part of the fix, not extra.
 * Hiragana, kanji and digits stay rejected so the field still means something
 * as a reading.
 *
 * ⚠️ The parts below are mirrored in
 * frontend/src/features/signup/nameRules.ts. Changing one side alone lets the
 * form accept a value the server then rejects.
 */

/** ァ-ヶ. Half-width katakana stays out, as before. */
const KATAKANA_LETTERS = "\\u30A1-\\u30F6";
/** ・ ー ヽ ヾ (U+30FB..U+30FE). */
const KATAKANA_MARKS = "\\u30FB-\\u30FE";
/**
 * Latin letters. Split in three to skip × (U+00D7) and ÷ (U+00F7);
 * U+1E00-U+1EFF carries the Vietnamese forms (ễ / ạ).
 */
const LATIN_LETTERS =
  "A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF";
/**
 * Combining diacritics: macOS and some IMEs hand us decomposed (NFD) text,
 * so "José" arrives as "e" + U+0301 and would be rejected without this.
 */
const COMBINING_MARKS = "\\u0300-\\u036F";
/** Half/full-width space plus the punctuation real names use. */
const NAME_SEPARATORS = "\\s\\u3000.'\\u2019-";

// COMBINING_MARKS is a deliberate RANGE, not a literal combining sequence —
// see its doc comment above.
// eslint-disable-next-line no-misleading-character-class
const KANA_OR_LATIN_PATTERN = new RegExp(
  `^[${KATAKANA_LETTERS}${KATAKANA_MARKS}${LATIN_LETTERS}` +
  `${COMBINING_MARKS}${NAME_SEPARATORS}]+$`,
);
/** Rejects separator-only input ("・・", " - "). */
const KANA_OR_LATIN_HAS_LETTER = new RegExp(
  `[${KATAKANA_LETTERS}${LATIN_LETTERS}]`,
);

const JAPAN_POSTAL_CODE_PATTERN = /^\d{3}-?\d{4}$/;

// Upper bounds on free-text fields, mirrored on the frontend's zod schemas
// so client-side validation rejects the same oversized inputs before
// submission rather than relying on a silent backend rejection.
const NAME_MAX_LENGTH = 100;
const PHONE_MAX_LENGTH = 20;
const ADDRESS_FIELD_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MAX_LENGTH = 128;

const japanAddressSchema = z.object({
  country: z.literal("JP"),
  postalCode: z.string().trim().regex(JAPAN_POSTAL_CODE_PATTERN),
  prefecture: z.enum(JAPAN_PREFECTURES),
  city: z.string().trim().min(1).max(ADDRESS_FIELD_MAX_LENGTH),
  addressLine: z.string().trim().min(1).max(ADDRESS_FIELD_MAX_LENGTH),
  building: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH).nullable(),
});

const internationalAddressSchema = z.object({
  country: z.enum(SUPPORTED_INTL_COUNTRIES),
  postalCode: z.string().trim().min(1).max(20),
  state: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH).nullable(),
  city: z.string().trim().min(1).max(ADDRESS_FIELD_MAX_LENGTH),
  addressLine1: z.string().trim().min(1).max(ADDRESS_FIELD_MAX_LENGTH),
  addressLine2: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH).nullable(),
});

export const addressInputSchema = z.discriminatedUnion("country", [
  japanAddressSchema,
  internationalAddressSchema,
]);

export const businessInputSchema = z.object({
  companyName: z.string().trim().min(1).max(ADDRESS_FIELD_MAX_LENGTH),
  department: z.string().trim().max(ADDRESS_FIELD_MAX_LENGTH).nullable(),
  contactPerson: z.string().trim().min(1).max(NAME_MAX_LENGTH),
});

const baseProfileObject = z.object({
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH),
  nameKana: z.string().trim().min(1).max(NAME_MAX_LENGTH)
    .regex(KANA_OR_LATIN_PATTERN)
    .regex(KANA_OR_LATIN_HAS_LETTER),
  phoneNumber: z.string().trim().min(1).max(PHONE_MAX_LENGTH),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(["male", "female", "other", "no_answer"]),
  newsletterOptIn: z.boolean(),
  accountType: z.enum(["individual", "sole-proprietor", "corporate"]),
  business: businessInputSchema.nullable(),
  address: addressInputSchema,
});

export const profileSchema = baseProfileObject.superRefine((values, ctx) => {
  const requiresBusiness = values.accountType !== "individual";
  if (requiresBusiness && values.business === null) {
    ctx.addIssue({code: "custom", path: ["business"], message: "invalid"});
  }
  if (!requiresBusiness && values.business !== null) {
    ctx.addIssue({code: "custom", path: ["business"], message: "invalid"});
  }

  const [year, month, day] = values.dateOfBirth.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isRealCalendarDate =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  if (!isRealCalendarDate || parsed.getTime() > Date.now()) {
    ctx.addIssue({code: "custom", path: ["dateOfBirth"], message: "invalid"});
  }
});

export const registrationInputSchema = z
  .object({
    email: z.string().trim().min(1).max(EMAIL_MAX_LENGTH),
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .and(profileSchema);

/** submitAdditionalInfo's input: the full profile, no email/password. */
export const additionalInfoInputSchema = profileSchema;
