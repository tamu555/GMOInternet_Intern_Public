/**
 * Address country selector (契約者情報 / additional-info).
 *
 * Deliberately NOT a full ISO-3166 list (task decision): Japan plus a short
 * list of major countries, matching the backend's own supported set
 * (`functions/src/auth/types.ts`'s `CountryCode`).
 */

export const JAPAN_COUNTRY_CODE = 'JP' as const

export const INTERNATIONAL_COUNTRY_CODES = ['US', 'GB', 'CN', 'KR', 'TW'] as const

export const SUPPORTED_COUNTRIES = [
  { code: JAPAN_COUNTRY_CODE, label: '日本' },
  { code: 'US', label: 'アメリカ合衆国' },
  { code: 'GB', label: 'イギリス' },
  { code: 'CN', label: '中国' },
  { code: 'KR', label: '韓国' },
  { code: 'TW', label: '台湾' },
] as const

export type CountryCode = (typeof SUPPORTED_COUNTRIES)[number]['code']
