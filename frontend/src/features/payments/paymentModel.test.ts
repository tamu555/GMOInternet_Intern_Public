import { describe, expect, it } from 'vitest'
import {
  buildDummyPaymentValues,
  buildInitialPaymentValues,
  describePayment,
  isPaymentComplete,
  validatePayment,
} from './paymentModel'
import { PAYMENT_METHOD_REQUIRED_ERROR } from './paymentMessages'
import type { PaymentFormValues, PaymentMethodId } from './paymentTypes'

const ALL_METHODS: PaymentMethodId[] = [
  'credit_card',
  'convenience_store',
  'bank_transfer',
  'direct_debit',
  'carrier',
  'qr',
  'paypal',
  'amazon_pay',
]

function withMethod(method: PaymentMethodId, overrides: Partial<PaymentFormValues> = {}): PaymentFormValues {
  return { ...buildInitialPaymentValues(), method, ...overrides }
}

describe('validatePayment: no method selected', () => {
  it('requires a method to be chosen', () => {
    expect(validatePayment(buildInitialPaymentValues())).toEqual({ method: PAYMENT_METHOD_REQUIRED_ERROR })
  })
})

describe('validatePayment: credit_card', () => {
  const now = new Date(2026, 7, 15) // 2026-08-15

  it('accepts a valid Visa test card', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
    })
    expect(validatePayment(values, now)).toEqual({})
  })

  it('rejects a checksum-broken card number', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '4242 4242 4242 4241', expiry: '12/30', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
    })
    expect(validatePayment(values, now).creditCard?.cardNumber).toBeDefined()
  })

  it('rejects an expired expiry date', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '4242 4242 4242 4242', expiry: '01/20', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
    })
    expect(validatePayment(values, now).creditCard?.expiry).toBeDefined()
  })

  it('rejects a holder name with non-alphabetic characters', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', holderName: '山田太郎', installments: 'lump_sum' },
    })
    expect(validatePayment(values, now).creditCard?.holderName).toBeDefined()
  })

  it('requires a 4-digit CVC for Amex', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '3782 822463 10005', expiry: '12/30', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
    })
    expect(validatePayment(values, now).creditCard?.cvc).toBeDefined()
  })

  it('describes a valid card as "brand •••• last4 / installments"', () => {
    const values = withMethod('credit_card', {
      creditCard: { cardNumber: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
    })
    expect(describePayment(values)).toBe('クレジットカード / デビットカード（Visa •••• 4242 / 一括払い）')
  })
})

describe('validatePayment: convenience_store', () => {
  it('accepts kana name + a valid phone number', () => {
    const values = withMethod('convenience_store', {
      convenienceStore: { chain: 'lawson', kana: 'ヤマダ タロウ', phone: '090-1234-5678' },
    })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects a non-katakana name', () => {
    const values = withMethod('convenience_store', {
      convenienceStore: { chain: 'lawson', kana: 'yamada', phone: '090-1234-5678' },
    })
    expect(validatePayment(values).convenienceStore?.kana).toBeDefined()
  })

  it('rejects a phone number with the wrong digit count', () => {
    const values = withMethod('convenience_store', {
      convenienceStore: { chain: 'lawson', kana: 'ヤマダ タロウ', phone: '090-123' },
    })
    expect(validatePayment(values).convenienceStore?.phone).toBeDefined()
  })

  it('describes the chosen chain', () => {
    const values = withMethod('convenience_store', {
      convenienceStore: { chain: 'lawson', kana: 'ヤマダ タロウ', phone: '090-1234-5678' },
    })
    expect(describePayment(values)).toBe('コンビニ決済（ローソン）')
  })
})

describe('validatePayment: bank_transfer', () => {
  const now = new Date(2026, 7, 15) // 2026-08-15

  it('accepts a kana name and a date within 90 days', () => {
    const values = withMethod('bank_transfer', { bankTransfer: { payerKana: 'ヤマダ タロウ', transferDate: '2026-09-01' } })
    expect(validatePayment(values, now)).toEqual({})
  })

  it('rejects a date in the past', () => {
    const values = withMethod('bank_transfer', { bankTransfer: { payerKana: 'ヤマダ タロウ', transferDate: '2026-08-01' } })
    expect(validatePayment(values, now).bankTransfer?.transferDate).toBeDefined()
  })

  it('rejects a date more than 90 days out', () => {
    const values = withMethod('bank_transfer', { bankTransfer: { payerKana: 'ヤマダ タロウ', transferDate: '2027-01-01' } })
    expect(validatePayment(values, now).bankTransfer?.transferDate).toBeDefined()
  })

  it('describes the transfer date in Japanese', () => {
    const values = withMethod('bank_transfer', { bankTransfer: { payerKana: 'ヤマダ タロウ', transferDate: '2026-09-01' } })
    expect(describePayment(values)).toBe('銀行振込（振込予定日: 2026年9月1日）')
  })
})

describe('validatePayment: direct_debit', () => {
  it('accepts a well-formed account', () => {
    const values = withMethod('direct_debit', {
      directDebit: { bank: 'mizuho', branchCode: '001', accountType: 'ordinary', accountNumber: '1234567', accountKana: 'ヤマダ タロウ' },
    })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects a branch code that is not 3 digits', () => {
    const values = withMethod('direct_debit', {
      directDebit: { bank: 'mizuho', branchCode: '1', accountType: 'ordinary', accountNumber: '1234567', accountKana: 'ヤマダ タロウ' },
    })
    expect(validatePayment(values).directDebit?.branchCode).toBeDefined()
  })

  it('rejects an account number that is not 7 digits', () => {
    const values = withMethod('direct_debit', {
      directDebit: { bank: 'mizuho', branchCode: '001', accountType: 'ordinary', accountNumber: '123', accountKana: 'ヤマダ タロウ' },
    })
    expect(validatePayment(values).directDebit?.accountNumber).toBeDefined()
  })

  it('describes the bank, account type, and masked account number', () => {
    const values = withMethod('direct_debit', {
      directDebit: { bank: 'mizuho', branchCode: '001', accountType: 'ordinary', accountNumber: '1234567', accountKana: 'ヤマダ タロウ' },
    })
    expect(describePayment(values)).toBe('口座振替（みずほ銀行 普通 •••4567）')
  })
})

describe('validatePayment: carrier', () => {
  it('accepts a valid 090 number', () => {
    const values = withMethod('carrier', { carrier: { carrier: 'docomo', phone: '090-1234-5678' } })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects a number that does not start with 070/080/090', () => {
    const values = withMethod('carrier', { carrier: { carrier: 'docomo', phone: '050-1234-5678' } })
    expect(validatePayment(values).carrier?.phone).toBeDefined()
  })

  it('rejects an empty phone number', () => {
    const values = withMethod('carrier', { carrier: { carrier: 'docomo', phone: '' } })
    expect(validatePayment(values).carrier?.phone).toBeDefined()
  })

  it('describes only the short carrier name', () => {
    const values = withMethod('carrier', { carrier: { carrier: 'docomo', phone: '090-1234-5678' } })
    expect(describePayment(values)).toBe('キャリア決済（ドコモ）')
  })
})

describe('validatePayment: qr', () => {
  it('accepts a 1-64 character contact value', () => {
    const values = withMethod('qr', { qr: { service: 'paypay', contact: '090-1234-5678' } })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects an empty contact value', () => {
    const values = withMethod('qr', { qr: { service: 'paypay', contact: '' } })
    expect(validatePayment(values).qr?.contact).toBeDefined()
  })

  it('rejects a contact value over 64 characters', () => {
    const values = withMethod('qr', { qr: { service: 'paypay', contact: 'x'.repeat(65) } })
    expect(validatePayment(values).qr?.contact).toBeDefined()
  })

  it('describes the chosen service', () => {
    const values = withMethod('qr', { qr: { service: 'paypay', contact: '090-1234-5678' } })
    expect(describePayment(values)).toBe('QRコード・スマホ決済（PayPay）')
  })
})

describe('validatePayment: paypal', () => {
  it('accepts a well-formed email', () => {
    const values = withMethod('paypal', { paypal: { email: 'taro@example.com' } })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects an empty email', () => {
    const values = withMethod('paypal', { paypal: { email: '' } })
    expect(validatePayment(values).paypal?.email).toBeDefined()
  })

  it('rejects a malformed email', () => {
    const values = withMethod('paypal', { paypal: { email: 'not-an-email' } })
    expect(validatePayment(values).paypal?.email).toBeDefined()
  })

  it('describes the masked email', () => {
    const values = withMethod('paypal', { paypal: { email: 'taro@example.com' } })
    expect(describePayment(values)).toBe('PayPal（t•••@example.com）')
  })
})

describe('validatePayment: amazon_pay', () => {
  it('accepts a well-formed email', () => {
    const values = withMethod('amazon_pay', { amazonPay: { email: 'taro@example.com' } })
    expect(validatePayment(values)).toEqual({})
  })

  it('rejects an empty email', () => {
    const values = withMethod('amazon_pay', { amazonPay: { email: '' } })
    expect(validatePayment(values).amazonPay?.email).toBeDefined()
  })

  it('rejects a malformed email', () => {
    const values = withMethod('amazon_pay', { amazonPay: { email: 'not-an-email' } })
    expect(validatePayment(values).amazonPay?.email).toBeDefined()
  })

  it('describes the masked email', () => {
    const values = withMethod('amazon_pay', { amazonPay: { email: 'taro@example.com' } })
    expect(describePayment(values)).toBe('Amazon Pay（t•••@example.com）')
  })
})

describe('switching method never leaks another method\'s errors', () => {
  it('drops the credit_card errors once the member switches to paypal, even with invalid leftover card data', () => {
    const invalidCard = withMethod('credit_card', {
      creditCard: { cardNumber: 'not-a-number', expiry: 'bad', cvc: '', holderName: '', installments: 'lump_sum' },
    })
    expect(Object.keys(validatePayment(invalidCard)).length).toBeGreaterThan(0)

    const switchedToPaypal: PaymentFormValues = { ...invalidCard, method: 'paypal', paypal: { email: 'taro@example.com' } }
    expect(validatePayment(switchedToPaypal)).toEqual({})
  })
})

describe('buildDummyPaymentValues', () => {
  it.each(ALL_METHODS)('produces values that pass validatePayment for %s', (method) => {
    expect(validatePayment(buildDummyPaymentValues(method))).toEqual({})
  })

  it.each(ALL_METHODS)('is reported complete by isPaymentComplete for %s', (method) => {
    expect(isPaymentComplete(buildDummyPaymentValues(method))).toBe(true)
  })
})

describe('isPaymentComplete', () => {
  it('is false while no method is selected', () => {
    expect(isPaymentComplete(buildInitialPaymentValues())).toBe(false)
  })
})

describe('describePayment never exposes a full card number or a CVC', () => {
  it('checks every dummy method', () => {
    for (const method of ALL_METHODS) {
      const description = describePayment(buildDummyPaymentValues(method))
      expect(description).not.toContain('4242424242424242')
      expect(description).not.toContain('123')
    }
  })

  it('returns null before enough information exists to summarize', () => {
    expect(describePayment(buildInitialPaymentValues())).toBeNull()
  })
})
