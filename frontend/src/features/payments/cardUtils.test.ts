import { describe, expect, it } from 'vitest'
import {
  detectCardBrand,
  expectedCardNumberLength,
  expectedCvcLength,
  formatCardExpiry,
  formatCardNumber,
  isExpiredCardExpiry,
  luhnCheck,
  maskCardNumber,
  maskEmail,
  maskTail,
} from './cardUtils'

// Well-known published test card numbers (not real cards), one per brand.
const VISA = '4111111111111111'
const MASTERCARD = '5555555555554444'
const JCB = '3530111333300000'
const AMEX = '378282246310005'
const DINERS = '30569309025904'

describe('detectCardBrand', () => {
  it('detects Visa from the leading 4', () => {
    expect(detectCardBrand(VISA)).toBe('visa')
  })

  it('detects Mastercard from the 51-55 / 2221-2720 ranges', () => {
    expect(detectCardBrand(MASTERCARD)).toBe('mastercard')
    expect(detectCardBrand('2221000000000000')).toBe('mastercard')
    expect(detectCardBrand('2720000000000000')).toBe('mastercard')
  })

  it('detects JCB from the 3528-3589 range', () => {
    expect(detectCardBrand(JCB)).toBe('jcb')
  })

  it('detects American Express from 34/37', () => {
    expect(detectCardBrand(AMEX)).toBe('amex')
    expect(detectCardBrand('3712345678901')).toBe('amex')
  })

  it('detects Diners Club from 300-305 / 3095 / 36 / 38 / 39', () => {
    expect(detectCardBrand(DINERS)).toBe('diners')
    expect(detectCardBrand('36000000000000')).toBe('diners')
    expect(detectCardBrand('38000000000000')).toBe('diners')
  })

  it('returns null for an unrecognized or empty prefix', () => {
    expect(detectCardBrand('6011000000000000')).toBeNull()
    expect(detectCardBrand('')).toBeNull()
  })
})

describe('luhnCheck', () => {
  it('accepts known-valid test card numbers', () => {
    expect(luhnCheck(VISA)).toBe(true)
    expect(luhnCheck(MASTERCARD)).toBe(true)
    expect(luhnCheck(JCB)).toBe(true)
    expect(luhnCheck(AMEX)).toBe(true)
    expect(luhnCheck(DINERS)).toBe(true)
  })

  it('rejects a checksum-broken number', () => {
    expect(luhnCheck('4111111111111112')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(luhnCheck('')).toBe(false)
  })
})

describe('expectedCardNumberLength / expectedCvcLength', () => {
  it('gives amex 15 digits and a 4-digit CVC', () => {
    expect(expectedCardNumberLength('amex')).toBe(15)
    expect(expectedCvcLength('amex')).toBe(4)
  })

  it('gives diners 14 digits and a 3-digit CVC', () => {
    expect(expectedCardNumberLength('diners')).toBe(14)
    expect(expectedCvcLength('diners')).toBe(3)
  })

  it('gives every other brand (and unknown/null) 16 digits and a 3-digit CVC', () => {
    expect(expectedCardNumberLength('visa')).toBe(16)
    expect(expectedCardNumberLength('mastercard')).toBe(16)
    expect(expectedCardNumberLength('jcb')).toBe(16)
    expect(expectedCardNumberLength(null)).toBe(16)
    expect(expectedCvcLength('visa')).toBe(3)
    expect(expectedCvcLength(null)).toBe(3)
  })
})

describe('formatCardNumber', () => {
  it('groups a 16-digit number as 4-4-4-4', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111')
  })

  it('groups an Amex number as 4-6-5', () => {
    expect(formatCardNumber('378282246310005')).toBe('3782 822463 10005')
  })

  it('strips non-digit characters typed by the user', () => {
    expect(formatCardNumber('4111-1111 1111/1111')).toBe('4111 1111 1111 1111')
  })

  it('caps input at the detected brand max length', () => {
    expect(formatCardNumber('41111111111111119999')).toBe('4111 1111 1111 1111')
  })
})

describe('formatCardExpiry', () => {
  it('inserts the slash after 2 digits', () => {
    expect(formatCardExpiry('1226')).toBe('12/26')
  })

  it('leaves 2 or fewer digits unslashed', () => {
    expect(formatCardExpiry('1')).toBe('1')
    expect(formatCardExpiry('12')).toBe('12')
  })

  it('caps at 4 digits total', () => {
    expect(formatCardExpiry('122699')).toBe('12/26')
  })
})

describe('isExpiredCardExpiry (valid through the END of the expiry month)', () => {
  it('is NOT expired on the last instant of the expiry month', () => {
    const lastMomentOfAugust = new Date(2026, 7, 31, 23, 59, 59, 999)
    expect(isExpiredCardExpiry('08/26', lastMomentOfAugust)).toBe(false)
  })

  it('IS expired on the first instant of the following month', () => {
    const firstMomentOfSeptember = new Date(2026, 8, 1, 0, 0, 0, 0)
    expect(isExpiredCardExpiry('08/26', firstMomentOfSeptember)).toBe(true)
  })

  it('treats a malformed value as expired', () => {
    expect(isExpiredCardExpiry('2026-08', new Date(2026, 0, 1))).toBe(true)
    expect(isExpiredCardExpiry('13/26', new Date(2026, 0, 1))).toBe(true)
  })
})

describe('maskCardNumber', () => {
  it('shows only the last 4 digits behind a fixed bullet group', () => {
    expect(maskCardNumber('4242424242424242')).toBe('•••• 4242')
  })

  it('never exposes more digits than it was given', () => {
    expect(maskCardNumber('42')).toBe('•••• ••42')
  })
})

describe('maskEmail', () => {
  it('keeps the first local-part character and the whole domain', () => {
    expect(maskEmail('taro@example.com')).toBe('t•••@example.com')
  })
})

describe('maskTail', () => {
  it('keeps only the last N characters', () => {
    expect(maskTail('1234567', 4)).toBe('•••4567')
  })

  it('fully masks a value no longer than the keep count', () => {
    expect(maskTail('123', 4)).toBe('•••')
  })
})
