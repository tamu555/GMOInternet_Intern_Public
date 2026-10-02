/**
 * Type-only module for the dummy (疑似) payment feature.
 *
 * `PaymentFormValues` always carries one nested value object PER method, so
 * switching the selected method never loses what the member typed for another
 * method and never leaks one method's data into another method's validation
 * (see `validatePayment` in `paymentModel.ts`, which reads only the branch
 * that matches `method`).
 */

export type PaymentMethodId =
  | 'credit_card'
  | 'convenience_store'
  | 'bank_transfer'
  | 'direct_debit'
  | 'carrier'
  | 'qr'
  | 'paypal'
  | 'amazon_pay'

export type CardBrand = 'visa' | 'mastercard' | 'jcb' | 'amex' | 'diners'

export type CardInstallments = 'lump_sum' | 'three' | 'six' | 'twelve'

export type ConvenienceStoreChain =
  | 'seven_eleven'
  | 'lawson'
  | 'family_mart'
  | 'ministop'
  | 'daily_yamazaki'
  | 'seicomart'

export type BankName = 'mizuho' | 'mitsubishi_ufj' | 'mitsui_sumitomo' | 'resona' | 'yucho' | 'other'

/** 普通 / 当座. */
export type BankAccountType = 'ordinary' | 'checking'

export type CarrierId = 'docomo' | 'au' | 'softbank'

export type QrWalletId = 'paypay' | 'rakuten_pay' | 'd_barai' | 'au_pay' | 'line_pay' | 'merpay'

export type CreditCardValues = {
  /** Digits, formatted with spaces as the member types (see `cardUtils.formatCardNumber`). */
  cardNumber: string
  /** `MM/YY`. */
  expiry: string
  cvc: string
  holderName: string
  installments: CardInstallments
}

export type ConvenienceStoreValues = {
  chain: ConvenienceStoreChain
  /** 全角カタカナ＋スペース. */
  kana: string
  phone: string
}

export type BankTransferValues = {
  /** 全角カタカナ＋スペース. */
  payerKana: string
  /** `YYYY-MM-DD` (native `<input type="date">` value). */
  transferDate: string
}

export type DirectDebitValues = {
  bank: BankName
  branchCode: string
  accountType: BankAccountType
  accountNumber: string
  /** 全角カタカナ＋スペース. */
  accountKana: string
}

export type CarrierValues = {
  carrier: CarrierId
  phone: string
}

export type QrValues = {
  service: QrWalletId
  /** 登録電話番号またはID. */
  contact: string
}

export type PayPalValues = {
  email: string
}

export type AmazonPayValues = {
  email: string
}

export type PaymentFormValues = {
  method: PaymentMethodId | null
  creditCard: CreditCardValues
  convenienceStore: ConvenienceStoreValues
  bankTransfer: BankTransferValues
  directDebit: DirectDebitValues
  carrier: CarrierValues
  qr: QrValues
  paypal: PayPalValues
  amazonPay: AmazonPayValues
}

export type PaymentFormErrors = {
  method?: string
  creditCard?: Partial<Record<keyof CreditCardValues, string>>
  convenienceStore?: Partial<Record<keyof ConvenienceStoreValues, string>>
  bankTransfer?: Partial<Record<keyof BankTransferValues, string>>
  directDebit?: Partial<Record<keyof DirectDebitValues, string>>
  carrier?: Partial<Record<keyof CarrierValues, string>>
  qr?: Partial<Record<keyof QrValues, string>>
  paypal?: Partial<Record<keyof PayPalValues, string>>
  amazonPay?: Partial<Record<keyof AmazonPayValues, string>>
}
