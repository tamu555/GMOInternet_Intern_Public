/**
 * Pure state model for the dummy (疑似) payment feature: initial values, a
 * "ダミー値を入力" sample generator, a hand-written validator (no zod, mirrors
 * `features/orders/orderFormModel.ts`), and a masked one-line summary for a
 * 確認 screen.
 *
 * `PaymentFormValues` always holds a complete nested object per method (see
 * `paymentTypes.ts`). `validatePayment` reads ONLY the branch matching the
 * selected `method` — switching methods can never surface another method's
 * errors, and typing into a method's fields can never fail validation for a
 * method that is not selected.
 */
import {
  detectCardBrand,
  expectedCardNumberLength,
  expectedCvcLength,
  isExpiredCardExpiry,
  luhnCheck,
  maskCardNumber,
  maskEmail,
  maskTail,
} from './cardUtils'
import {
  BANK_LABELS,
  BANK_TRANSFER_DATE_INVALID_ERROR,
  BANK_TRANSFER_DATE_REQUIRED_ERROR,
  BANK_TRANSFER_PAYER_KANA_INVALID_ERROR,
  BANK_TRANSFER_PAYER_KANA_REQUIRED_ERROR,
  CARD_BRAND_LABELS,
  CARD_CVC_REQUIRED_ERROR,
  CARD_EXPIRY_EXPIRED_ERROR,
  CARD_EXPIRY_INVALID_ERROR,
  CARD_EXPIRY_REQUIRED_ERROR,
  CARD_HOLDER_INVALID_ERROR,
  CARD_HOLDER_REQUIRED_ERROR,
  CARD_NUMBER_INVALID_ERROR,
  CARD_NUMBER_REQUIRED_ERROR,
  CARRIER_OPTION_LABELS,
  CARRIER_PHONE_INVALID_ERROR,
  CARRIER_PHONE_REQUIRED_ERROR,
  CARRIER_SHORT_LABELS,
  CVS_CHAIN_LABELS,
  CVS_KANA_INVALID_ERROR,
  CVS_KANA_REQUIRED_ERROR,
  CVS_PHONE_INVALID_ERROR,
  CVS_PHONE_REQUIRED_ERROR,
  DESCRIBE_BANK_TRANSFER_DATE_PREFIX,
  DIRECT_DEBIT_ACCOUNT_KANA_INVALID_ERROR,
  DIRECT_DEBIT_ACCOUNT_KANA_REQUIRED_ERROR,
  DIRECT_DEBIT_ACCOUNT_NUMBER_INVALID_ERROR,
  DIRECT_DEBIT_BRANCH_CODE_INVALID_ERROR,
  ACCOUNT_TYPE_LABELS,
  cardCvcInvalidError,
  EMAIL_INVALID_ERROR,
  EMAIL_REQUIRED_ERROR,
  INSTALLMENT_LABELS,
  METHOD_LABEL_AMAZON_PAY,
  METHOD_LABEL_BANK_TRANSFER,
  METHOD_LABEL_CARRIER,
  METHOD_LABEL_CONVENIENCE_STORE,
  METHOD_LABEL_CREDIT_CARD,
  METHOD_LABEL_DIRECT_DEBIT,
  METHOD_LABEL_PAYPAL,
  METHOD_LABEL_QR,
  PAYMENT_METHOD_REQUIRED_ERROR,
  QR_CONTACT_INVALID_ERROR,
  QR_CONTACT_REQUIRED_ERROR,
  QR_SERVICE_LABELS,
} from './paymentMessages'
import type {
  AmazonPayValues,
  BankAccountType,
  BankName,
  BankTransferValues,
  CarrierId,
  CarrierValues,
  ConvenienceStoreChain,
  ConvenienceStoreValues,
  CreditCardValues,
  DirectDebitValues,
  PayPalValues,
  PaymentFormErrors,
  PaymentFormValues,
  PaymentMethodId,
  QrValues,
  QrWalletId,
} from './paymentTypes'

// ---------------------------------------------------------------------------
// Option lists for native <select> controls (order fixes the on-screen order).
// ---------------------------------------------------------------------------

export type SelectOption<T extends string> = { value: T; label: string }

export const CONVENIENCE_STORE_OPTIONS: readonly SelectOption<ConvenienceStoreChain>[] = (
  ['seven_eleven', 'lawson', 'family_mart', 'ministop', 'daily_yamazaki', 'seicomart'] as const
).map((value) => ({ value, label: CVS_CHAIN_LABELS[value] }))

export const BANK_OPTIONS: readonly SelectOption<BankName>[] = (
  ['mizuho', 'mitsubishi_ufj', 'mitsui_sumitomo', 'resona', 'yucho', 'other'] as const
).map((value) => ({ value, label: BANK_LABELS[value] }))

export const ACCOUNT_TYPE_OPTIONS: readonly SelectOption<BankAccountType>[] = (
  ['ordinary', 'checking'] as const
).map((value) => ({ value, label: ACCOUNT_TYPE_LABELS[value] }))

export const CARRIER_OPTIONS: readonly SelectOption<CarrierId>[] = (['docomo', 'au', 'softbank'] as const).map(
  (value) => ({ value, label: CARRIER_OPTION_LABELS[value] }),
)

export const QR_SERVICE_OPTIONS: readonly SelectOption<QrWalletId>[] = (
  ['paypay', 'rakuten_pay', 'd_barai', 'au_pay', 'line_pay', 'merpay'] as const
).map((value) => ({ value, label: QR_SERVICE_LABELS[value] }))

export const INSTALLMENT_OPTIONS: readonly SelectOption<CreditCardValues['installments']>[] = (
  ['lump_sum', 'three', 'six', 'twelve'] as const
).map((value) => ({ value, label: INSTALLMENT_LABELS[value] }))

// ---------------------------------------------------------------------------
// Shared validation patterns.
// ---------------------------------------------------------------------------

/** 全角カタカナ・長音記号・半角/全角スペースのみ。 */
const KATAKANA_SPACE_PATTERN = /^[ァ-ヺー\s]+$/
const KANA_MAX_LENGTH = 40
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validateKana(value: string, requiredError: string, invalidError: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return requiredError
  if (trimmed.length > KANA_MAX_LENGTH || !KATAKANA_SPACE_PATTERN.test(trimmed)) return invalidError
  return undefined
}

function validateEmail(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return EMAIL_REQUIRED_ERROR
  if (!EMAIL_PATTERN.test(trimmed)) return EMAIL_INVALID_ERROR
  return undefined
}

function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const BANK_TRANSFER_MAX_LEAD_DAYS = 90

function formatJapaneseDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`
}

// ---------------------------------------------------------------------------
// Initial / dummy values.
// ---------------------------------------------------------------------------

export function buildInitialPaymentValues(): PaymentFormValues {
  return {
    method: null,
    creditCard: { cardNumber: '', expiry: '', cvc: '', holderName: '', installments: 'lump_sum' },
    convenienceStore: { chain: 'seven_eleven', kana: '', phone: '' },
    bankTransfer: { payerKana: '', transferDate: '' },
    directDebit: { bank: 'mizuho', branchCode: '', accountType: 'ordinary', accountNumber: '', accountKana: '' },
    carrier: { carrier: 'docomo', phone: '' },
    qr: { service: 'paypay', contact: '' },
    paypal: { email: '' },
    amazonPay: { email: '' },
  }
}

/** yyyy-mm-dd for `today + days`, using the local calendar date. */
function isoDateInDays(days: number): string {
  const date = addDays(new Date(), days)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Valid sample data for the 「ダミー値を入力」 button. Always passes `validatePayment`. */
export function buildDummyPaymentValues(method: PaymentMethodId): PaymentFormValues {
  const base = buildInitialPaymentValues()

  switch (method) {
    case 'credit_card':
      return {
        ...base,
        method,
        // Well-known Visa test number (Luhn-valid, not a real card).
        creditCard: { cardNumber: '4242 4242 4242 4242', expiry: '12/99', cvc: '123', holderName: 'TARO YAMADA', installments: 'lump_sum' },
      }
    case 'convenience_store':
      return {
        ...base,
        method,
        convenienceStore: { chain: 'lawson', kana: 'ヤマダ タロウ', phone: '090-1234-5678' },
      }
    case 'bank_transfer':
      return {
        ...base,
        method,
        bankTransfer: { payerKana: 'ヤマダ タロウ', transferDate: isoDateInDays(7) },
      }
    case 'direct_debit':
      return {
        ...base,
        method,
        directDebit: {
          bank: 'mizuho',
          branchCode: '001',
          accountType: 'ordinary',
          accountNumber: '1234567',
          accountKana: 'ヤマダ タロウ',
        },
      }
    case 'carrier':
      return { ...base, method, carrier: { carrier: 'docomo', phone: '090-1234-5678' } }
    case 'qr':
      return { ...base, method, qr: { service: 'paypay', contact: '090-1234-5678' } }
    case 'paypal':
      return { ...base, method, paypal: { email: 'taro.yamada@example.com' } }
    case 'amazon_pay':
      return { ...base, method, amazonPay: { email: 'taro.yamada@example.com' } }
    default:
      return { ...base, method }
  }
}

// ---------------------------------------------------------------------------
// Per-method validators.
// ---------------------------------------------------------------------------

function validateCreditCard(values: CreditCardValues, now: Date): NonNullable<PaymentFormErrors['creditCard']> {
  const errors: NonNullable<PaymentFormErrors['creditCard']> = {}

  const digits = values.cardNumber.replace(/\D/g, '')
  if (digits.length === 0) {
    errors.cardNumber = CARD_NUMBER_REQUIRED_ERROR
  } else {
    const brand = detectCardBrand(digits)
    if (!brand || digits.length !== expectedCardNumberLength(brand) || !luhnCheck(digits)) {
      errors.cardNumber = CARD_NUMBER_INVALID_ERROR
    }
  }

  const expiry = values.expiry.trim()
  if (expiry.length === 0) {
    errors.expiry = CARD_EXPIRY_REQUIRED_ERROR
  } else if (!/^\d{2}\/\d{2}$/.test(expiry)) {
    errors.expiry = CARD_EXPIRY_INVALID_ERROR
  } else if (isExpiredCardExpiry(expiry, now)) {
    errors.expiry = CARD_EXPIRY_EXPIRED_ERROR
  }

  const cvcDigits = values.cvc.trim()
  const brandForCvc = detectCardBrand(digits)
  const expectedCvc = expectedCvcLength(brandForCvc)
  if (cvcDigits.length === 0) {
    errors.cvc = CARD_CVC_REQUIRED_ERROR
  } else if (!/^\d+$/.test(cvcDigits) || cvcDigits.length !== expectedCvc) {
    errors.cvc = cardCvcInvalidError(expectedCvc)
  }

  const holder = values.holderName.trim()
  if (holder.length === 0) {
    errors.holderName = CARD_HOLDER_REQUIRED_ERROR
  } else if (holder.length > 48 || !/^[A-Za-z ]+$/.test(holder)) {
    errors.holderName = CARD_HOLDER_INVALID_ERROR
  }

  return errors
}

function validateConvenienceStore(values: ConvenienceStoreValues): NonNullable<PaymentFormErrors['convenienceStore']> {
  const errors: NonNullable<PaymentFormErrors['convenienceStore']> = {}

  const kanaError = validateKana(values.kana, CVS_KANA_REQUIRED_ERROR, CVS_KANA_INVALID_ERROR)
  if (kanaError) errors.kana = kanaError

  const phone = values.phone.trim()
  const phoneDigits = phone.replace(/-/g, '')
  if (phone.length === 0) {
    errors.phone = CVS_PHONE_REQUIRED_ERROR
  } else if (!/^[\d-]+$/.test(phone) || !/^\d{10,11}$/.test(phoneDigits)) {
    errors.phone = CVS_PHONE_INVALID_ERROR
  }

  return errors
}

function validateBankTransfer(values: BankTransferValues, now: Date): NonNullable<PaymentFormErrors['bankTransfer']> {
  const errors: NonNullable<PaymentFormErrors['bankTransfer']> = {}

  const kanaError = validateKana(
    values.payerKana,
    BANK_TRANSFER_PAYER_KANA_REQUIRED_ERROR,
    BANK_TRANSFER_PAYER_KANA_INVALID_ERROR,
  )
  if (kanaError) errors.payerKana = kanaError

  if (values.transferDate.trim().length === 0) {
    errors.transferDate = BANK_TRANSFER_DATE_REQUIRED_ERROR
  } else {
    const date = parseIsoDate(values.transferDate)
    const today = startOfDay(now)
    const maxDate = addDays(today, BANK_TRANSFER_MAX_LEAD_DAYS)
    if (!date || date < today || date > maxDate) {
      errors.transferDate = BANK_TRANSFER_DATE_INVALID_ERROR
    }
  }

  return errors
}

function validateDirectDebit(values: DirectDebitValues): NonNullable<PaymentFormErrors['directDebit']> {
  const errors: NonNullable<PaymentFormErrors['directDebit']> = {}

  if (!/^\d{3}$/.test(values.branchCode.trim())) {
    errors.branchCode = DIRECT_DEBIT_BRANCH_CODE_INVALID_ERROR
  }
  if (!/^\d{7}$/.test(values.accountNumber.trim())) {
    errors.accountNumber = DIRECT_DEBIT_ACCOUNT_NUMBER_INVALID_ERROR
  }

  const kanaError = validateKana(
    values.accountKana,
    DIRECT_DEBIT_ACCOUNT_KANA_REQUIRED_ERROR,
    DIRECT_DEBIT_ACCOUNT_KANA_INVALID_ERROR,
  )
  if (kanaError) errors.accountKana = kanaError

  return errors
}

function validateCarrier(values: CarrierValues): NonNullable<PaymentFormErrors['carrier']> {
  const errors: NonNullable<PaymentFormErrors['carrier']> = {}

  const phone = values.phone.trim()
  const digits = phone.replace(/-/g, '')
  if (phone.length === 0) {
    errors.phone = CARRIER_PHONE_REQUIRED_ERROR
  } else if (!/^[\d-]+$/.test(phone) || !/^(070|080|090)\d{8}$/.test(digits)) {
    errors.phone = CARRIER_PHONE_INVALID_ERROR
  }

  return errors
}

function validateQr(values: QrValues): NonNullable<PaymentFormErrors['qr']> {
  const errors: NonNullable<PaymentFormErrors['qr']> = {}

  const contact = values.contact.trim()
  if (contact.length === 0) {
    errors.contact = QR_CONTACT_REQUIRED_ERROR
  } else if (contact.length > 64) {
    errors.contact = QR_CONTACT_INVALID_ERROR
  }

  return errors
}

function validatePayPal(values: PayPalValues): NonNullable<PaymentFormErrors['paypal']> {
  const error = validateEmail(values.email)
  return error ? { email: error } : {}
}

function validateAmazonPay(values: AmazonPayValues): NonNullable<PaymentFormErrors['amazonPay']> {
  const error = validateEmail(values.email)
  return error ? { email: error } : {}
}

/**
 * Validates ONLY the currently selected method's nested object. The other
 * seven method objects are never inspected, so typed-but-unused data in them
 * can never surface an error and switching `method` never carries an old
 * error forward.
 */
export function validatePayment(values: PaymentFormValues, now: Date = new Date()): PaymentFormErrors {
  if (!values.method) return { method: PAYMENT_METHOD_REQUIRED_ERROR }

  switch (values.method) {
    case 'credit_card': {
      const creditCard = validateCreditCard(values.creditCard, now)
      return Object.keys(creditCard).length > 0 ? { creditCard } : {}
    }
    case 'convenience_store': {
      const convenienceStore = validateConvenienceStore(values.convenienceStore)
      return Object.keys(convenienceStore).length > 0 ? { convenienceStore } : {}
    }
    case 'bank_transfer': {
      const bankTransfer = validateBankTransfer(values.bankTransfer, now)
      return Object.keys(bankTransfer).length > 0 ? { bankTransfer } : {}
    }
    case 'direct_debit': {
      const directDebit = validateDirectDebit(values.directDebit)
      return Object.keys(directDebit).length > 0 ? { directDebit } : {}
    }
    case 'carrier': {
      const carrier = validateCarrier(values.carrier)
      return Object.keys(carrier).length > 0 ? { carrier } : {}
    }
    case 'qr': {
      const qr = validateQr(values.qr)
      return Object.keys(qr).length > 0 ? { qr } : {}
    }
    case 'paypal': {
      const paypal = validatePayPal(values.paypal)
      return Object.keys(paypal).length > 0 ? { paypal } : {}
    }
    case 'amazon_pay': {
      const amazonPay = validateAmazonPay(values.amazonPay)
      return Object.keys(amazonPay).length > 0 ? { amazonPay } : {}
    }
    default:
      return {}
  }
}

export function isPaymentComplete(values: PaymentFormValues, now?: Date): boolean {
  if (!values.method) return false
  return Object.keys(validatePayment(values, now)).length === 0
}

/**
 * Masked one-line summary for a 確認 screen. Returns null while the selected
 * method's identifying field is still empty. Never exposes more than the
 * last 4 digits of anything, and never the CVC.
 */
export function describePayment(values: PaymentFormValues): string | null {
  if (!values.method) return null

  switch (values.method) {
    case 'credit_card': {
      const digits = values.creditCard.cardNumber.replace(/\D/g, '')
      const brand = detectCardBrand(digits)
      if (!brand || digits.length === 0) return null
      const installmentLabel = INSTALLMENT_LABELS[values.creditCard.installments]
      return `${METHOD_LABEL_CREDIT_CARD}（${CARD_BRAND_LABELS[brand]} ${maskCardNumber(digits)} / ${installmentLabel}）`
    }
    case 'convenience_store':
      return `${METHOD_LABEL_CONVENIENCE_STORE}（${CVS_CHAIN_LABELS[values.convenienceStore.chain]}）`
    case 'bank_transfer': {
      if (!values.bankTransfer.transferDate) return null
      return `${METHOD_LABEL_BANK_TRANSFER}（${DESCRIBE_BANK_TRANSFER_DATE_PREFIX}${formatJapaneseDate(values.bankTransfer.transferDate)}）`
    }
    case 'direct_debit': {
      if (!values.directDebit.accountNumber) return null
      const { bank, accountType, accountNumber } = values.directDebit
      return `${METHOD_LABEL_DIRECT_DEBIT}（${BANK_LABELS[bank]} ${ACCOUNT_TYPE_LABELS[accountType]} ${maskTail(accountNumber, 4)}）`
    }
    case 'carrier':
      return `${METHOD_LABEL_CARRIER}（${CARRIER_SHORT_LABELS[values.carrier.carrier]}）`
    case 'qr':
      return `${METHOD_LABEL_QR}（${QR_SERVICE_LABELS[values.qr.service]}）`
    case 'paypal': {
      if (!values.paypal.email) return null
      return `${METHOD_LABEL_PAYPAL}（${maskEmail(values.paypal.email)}）`
    }
    case 'amazon_pay': {
      if (!values.amazonPay.email) return null
      return `${METHOD_LABEL_AMAZON_PAY}（${maskEmail(values.amazonPay.email)}）`
    }
    default:
      return null
  }
}
