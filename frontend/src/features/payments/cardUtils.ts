/**
 * Pure, framework-free helpers for the dummy credit-card fields: brand
 * detection, Luhn check, input formatting/masking. No React, no I/O — every
 * function here is a straight string/date transform so it is trivial to unit
 * test (`cardUtils.test.ts`).
 */
import type { CardBrand } from './paymentTypes'

const MAX_MASK_BULLETS = 4

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Brand ranges (IIN prefixes): Visa `4`; Mastercard `51-55` or `2221-2720`;
 * JCB `3528-3589`; Amex `34`/`37`; Diners `300-305`, `3095`, `36`, `38`, `39`.
 * Amex/Diners are checked first — `34`/`37`/`36`/`38`/`39` fully live inside
 * Visa's `3xxxx...` gap, but never overlap the Mastercard/JCB ranges above.
 */
export function detectCardBrand(digits: string): CardBrand | null {
  const clean = onlyDigits(digits)
  if (clean.length === 0) return null

  if (/^4/.test(clean)) return 'visa'
  if (/^3[47]/.test(clean)) return 'amex'

  const twoDigit = Number(clean.slice(0, 2))
  const threeDigit = Number(clean.slice(0, 3))
  const fourDigit = Number(clean.slice(0, 4))

  if ((twoDigit >= 51 && twoDigit <= 55) || (fourDigit >= 2221 && fourDigit <= 2720)) return 'mastercard'
  if (fourDigit >= 3528 && fourDigit <= 3589) return 'jcb'
  if ((threeDigit >= 300 && threeDigit <= 305) || clean.slice(0, 4) === '3095' || /^3[689]/.test(clean)) {
    return 'diners'
  }

  return null
}

/** Standard mod-10 checksum. Empty input is never valid. */
export function luhnCheck(digits: string): boolean {
  const clean = onlyDigits(digits)
  if (clean.length === 0) return false

  let sum = 0
  let shouldDouble = false
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = Number(clean[i])
    if (shouldDouble) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    shouldDouble = !shouldDouble
  }
  return sum % 10 === 0
}

export function expectedCardNumberLength(brand: CardBrand | null): number {
  if (brand === 'amex') return 15
  if (brand === 'diners') return 14
  return 16
}

/** Amex CVC is 4 digits (printed on the front); every other brand is 3. */
export function expectedCvcLength(brand: CardBrand | null): number {
  return brand === 'amex' ? 4 : 3
}

/** Strips non-digits, caps at the detected brand's length, groups for display. */
export function formatCardNumber(input: string): string {
  const brand = detectCardBrand(input)
  const digits = onlyDigits(input).slice(0, expectedCardNumberLength(brand))

  if (brand === 'amex') {
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)].filter(Boolean).join(' ')
  }

  const groups: string[] = []
  for (let i = 0; i < digits.length; i += 4) {
    groups.push(digits.slice(i, i + 4))
  }
  return groups.join(' ')
}

/** Digits → `MM/YY`, capped at 4 digits total. */
export function formatCardExpiry(input: string): string {
  const digits = onlyDigits(input).slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}/${digits.slice(2)}`
}

/**
 * A card is valid through the END of its expiry month (industry convention).
 * `mmYY` must already be `MM/YY`; anything else is treated as expired so a
 * malformed value never slips past a "not expired" check.
 */
export function isExpiredCardExpiry(mmYY: string, now: Date = new Date()): boolean {
  const match = /^(\d{2})\/(\d{2})$/.exec(mmYY)
  if (!match) return true

  const month = Number(match[1])
  const year = 2000 + Number(match[2])
  if (month < 1 || month > 12) return true

  // Day 0 of the NEXT month is the last day of `month` (Date normalizes this).
  const endOfExpiryMonth = new Date(year, month, 0, 23, 59, 59, 999)
  return now.getTime() > endOfExpiryMonth.getTime()
}

/**
 * `•••• 4242`. Never surfaces more than the last 4 digits — if fewer than 4
 * digits exist at all, the missing places stay bulleted instead of shown.
 */
export function maskCardNumber(digits: string): string {
  const clean = onlyDigits(digits)
  const last4 = clean.slice(-4).padStart(4, '•')
  return `•••• ${last4}`
}

/** `t•••@example.com`: first local-part character kept, domain kept as-is. */
export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@')
  if (atIndex <= 0) return maskTail(email, 0)

  const visible = email.slice(0, 1)
  const domain = email.slice(atIndex)
  return `${visible}${'•'.repeat(3)}${domain}`
}

/** Masks every character except the last `keep`, e.g. `maskTail('1234567', 4)` → `•••4567`. */
export function maskTail(value: string, keep: number): string {
  const clean = value.trim()
  if (clean.length === 0) return ''
  if (keep <= 0 || clean.length <= keep) return '•'.repeat(Math.min(clean.length, MAX_MASK_BULLETS))

  const visible = clean.slice(-keep)
  const hiddenLength = clean.length - keep
  return `${'•'.repeat(Math.min(hiddenLength, MAX_MASK_BULLETS))}${visible}`
}
