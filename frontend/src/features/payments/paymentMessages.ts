/**
 * User-facing wording for the dummy (疑似) payment feature. One module so no
 * Japanese string is ever written inline in JSX or in the validator — mirrors
 * `features/orders/orderMessages.ts`.
 */
import type {
  BankAccountType,
  BankName,
  CardBrand,
  CardInstallments,
  CarrierId,
  ConvenienceStoreChain,
  QrWalletId,
} from './paymentTypes'

export const PAYMENT_SECTION_HEADING = 'お支払い方法'

export const PAYMENT_SECTION_LEDE =
  'ご希望のお支払い方法を選択し、必要な項目をご入力ください。'

/**
 * Hard security requirement (not decoration): the visitor must be told this
 * is a fake checkout AND must be told not to type anything real.
 *
 * ⚠️ Deliberately NOT a repeat of `orders/orderMessages.ts`'s
 * `PSEUDO_PAYMENT_NOTICE` wording. Two of the three screens that mount
 * `PaymentSection` already render that exact sentence, and their flow tests
 * locate it with a single `getByText` — a byte-identical second copy would
 * make that query ambiguous and would read as duplicated boilerplate to the
 * member. This banner carries the part the other one does not: do not type
 * anything real.
 */
export const DUMMY_PAYMENT_INPUT_NOTICE =
  '疑似決済のため、実際の請求は発生しません。カード番号・口座番号・電話番号などは、実在するご自身の情報を入力せず、ダミーの値のみをご入力ください。'

export const PAYMENT_METHOD_REQUIRED_ERROR = 'お支払い方法を選択してください。'

export const FILL_DUMMY_ACTION = 'ダミー値を入力'

// ---------------------------------------------------------------------------
// Method catalogue (labels/summaries shown by PaymentMethodSelector).
// ---------------------------------------------------------------------------

export const METHOD_LABEL_CREDIT_CARD = 'クレジットカード / デビットカード'
export const METHOD_SUMMARY_CREDIT_CARD = '主要な国際ブランドに対応（疑似決済）'

export const METHOD_LABEL_CONVENIENCE_STORE = 'コンビニ決済'
export const METHOD_SUMMARY_CONVENIENCE_STORE = '発行された番号でお近くのコンビニからお支払い'

export const METHOD_LABEL_BANK_TRANSFER = '銀行振込'
export const METHOD_SUMMARY_BANK_TRANSFER = '指定の口座へお振込みいただく方法'

export const METHOD_LABEL_DIRECT_DEBIT = '口座振替'
export const METHOD_SUMMARY_DIRECT_DEBIT = '登録した口座から自動で引き落とし'

export const METHOD_LABEL_CARRIER = 'キャリア決済'
export const METHOD_SUMMARY_CARRIER = '携帯電話の料金と合算してお支払い'

export const METHOD_LABEL_QR = 'QRコード・スマホ決済'
export const METHOD_SUMMARY_QR = 'PayPayなど各種スマホ決済サービス'

export const METHOD_LABEL_PAYPAL = 'PayPal'
export const METHOD_SUMMARY_PAYPAL = 'PayPalアカウントでのお支払い'

export const METHOD_LABEL_AMAZON_PAY = 'Amazon Pay'
export const METHOD_SUMMARY_AMAZON_PAY = 'Amazonに登録済みの情報でお支払い'

// ---------------------------------------------------------------------------
// credit_card
// ---------------------------------------------------------------------------

export const CARD_NUMBER_LABEL = 'カード番号'
export const CARD_NUMBER_PLACEHOLDER = '4242 4242 4242 4242'
export const CARD_EXPIRY_LABEL = '有効期限'
export const CARD_EXPIRY_PLACEHOLDER = 'MM/YY'
export const CARD_CVC_LABEL = 'セキュリティコード'
export const CARD_HOLDER_LABEL = 'カード名義'
export const CARD_HOLDER_PLACEHOLDER = 'TARO YAMADA'
export const CARD_HOLDER_HINT = 'カード券面のとおり、半角英字とスペースのみで入力してください。'
export const CARD_INSTALLMENTS_LABEL = '支払回数'

export const CARD_BRAND_LABELS: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  jcb: 'JCB',
  amex: 'American Express',
  diners: 'Diners Club',
}

export const INSTALLMENT_LABELS: Record<CardInstallments, string> = {
  lump_sum: '一括払い',
  three: '3回払い',
  six: '6回払い',
  twelve: '12回払い',
}

export const CARD_NUMBER_REQUIRED_ERROR = 'カード番号を入力してください。'
export const CARD_NUMBER_INVALID_ERROR = 'カード番号の形式が正しくありません。'
export const CARD_EXPIRY_REQUIRED_ERROR = '有効期限を入力してください。'
export const CARD_EXPIRY_INVALID_ERROR = '有効期限はMM/YY形式（例: 12/26）で入力してください。'
export const CARD_EXPIRY_EXPIRED_ERROR = '有効期限が過ぎています。'
export const CARD_CVC_REQUIRED_ERROR = 'セキュリティコードを入力してください。'
export const CARD_HOLDER_REQUIRED_ERROR = 'カード名義を入力してください。'
export const CARD_HOLDER_INVALID_ERROR = 'カード名義は半角英字とスペースのみ、48文字以内で入力してください。'

export function cardCvcInvalidError(length: number): string {
  return `セキュリティコードは${length}桁の数字で入力してください。`
}

// ---------------------------------------------------------------------------
// convenience_store
// ---------------------------------------------------------------------------

export const CVS_CHAIN_LABEL = 'コンビニ'
export const CVS_KANA_LABEL = 'お名前（カナ）'
export const CVS_KANA_PLACEHOLDER = 'ヤマダ タロウ'
export const CVS_PHONE_LABEL = '電話番号'
export const CVS_PHONE_PLACEHOLDER = '090-1234-5678'

export const CVS_CHAIN_LABELS: Record<ConvenienceStoreChain, string> = {
  seven_eleven: 'セブン-イレブン',
  lawson: 'ローソン',
  family_mart: 'ファミリーマート',
  ministop: 'ミニストップ',
  daily_yamazaki: 'デイリーヤマザキ',
  seicomart: 'セイコーマート',
}

export const CVS_KANA_REQUIRED_ERROR = 'お名前（カナ）を入力してください。'
export const CVS_KANA_INVALID_ERROR = '全角カタカナとスペースのみ、40文字以内で入力してください。'
export const CVS_PHONE_REQUIRED_ERROR = '電話番号を入力してください。'
export const CVS_PHONE_INVALID_ERROR = '電話番号はハイフンを含む数字で、10〜11桁で入力してください。'

// ---------------------------------------------------------------------------
// bank_transfer
// ---------------------------------------------------------------------------

export const BANK_TRANSFER_PAYER_KANA_LABEL = '振込人名義（カナ）'
export const BANK_TRANSFER_DATE_LABEL = '振込予定日'
export const BANK_TRANSFER_DATE_HINT = '本日から90日以内の日付を選択してください。'
export const BANK_TRANSFER_DESTINATION_HEADING = 'お振込み先（ダミー）'
export const BANK_TRANSFER_DESTINATION_BANK = 'そら銀行 みどり支店（普通）'
export const BANK_TRANSFER_DESTINATION_ACCOUNT_NUMBER = '1234567'
export const BANK_TRANSFER_DESTINATION_HOLDER = 'カ）ドメインズギジ'

export const BANK_TRANSFER_PAYER_KANA_REQUIRED_ERROR = '振込人名義（カナ）を入力してください。'
export const BANK_TRANSFER_PAYER_KANA_INVALID_ERROR = '全角カタカナとスペースのみ、40文字以内で入力してください。'
export const BANK_TRANSFER_DATE_REQUIRED_ERROR = '振込予定日を選択してください。'
export const BANK_TRANSFER_DATE_INVALID_ERROR = '振込予定日は本日から90日以内の日付を選択してください。'

export const DESCRIBE_BANK_TRANSFER_DATE_PREFIX = '振込予定日: '

// ---------------------------------------------------------------------------
// direct_debit
// ---------------------------------------------------------------------------

export const DIRECT_DEBIT_BANK_LABEL = '金融機関'
export const DIRECT_DEBIT_BRANCH_CODE_LABEL = '支店コード'
export const DIRECT_DEBIT_ACCOUNT_TYPE_LABEL = '口座種別'
export const DIRECT_DEBIT_ACCOUNT_NUMBER_LABEL = '口座番号'
export const DIRECT_DEBIT_ACCOUNT_KANA_LABEL = '口座名義（カナ）'

export const BANK_LABELS: Record<BankName, string> = {
  mizuho: 'みずほ銀行',
  mitsubishi_ufj: '三菱UFJ銀行',
  mitsui_sumitomo: '三井住友銀行',
  resona: 'りそな銀行',
  yucho: 'ゆうちょ銀行',
  other: 'その他の金融機関',
}

export const ACCOUNT_TYPE_LABELS: Record<BankAccountType, string> = {
  ordinary: '普通',
  checking: '当座',
}

export const DIRECT_DEBIT_BRANCH_CODE_INVALID_ERROR = '支店コードは3桁の数字で入力してください。'
export const DIRECT_DEBIT_ACCOUNT_NUMBER_INVALID_ERROR = '口座番号は7桁の数字で入力してください。'
export const DIRECT_DEBIT_ACCOUNT_KANA_REQUIRED_ERROR = '口座名義（カナ）を入力してください。'
export const DIRECT_DEBIT_ACCOUNT_KANA_INVALID_ERROR = '全角カタカナとスペースのみ、40文字以内で入力してください。'

// ---------------------------------------------------------------------------
// carrier
// ---------------------------------------------------------------------------

export const CARRIER_LABEL = 'キャリア'
export const CARRIER_PHONE_LABEL = '携帯電話番号'
export const CARRIER_PHONE_PLACEHOLDER = '090-1234-5678'

/** Short display name, used on the describePayment summary. */
export const CARRIER_SHORT_LABELS: Record<CarrierId, string> = {
  docomo: 'ドコモ',
  au: 'au',
  softbank: 'ソフトバンク',
}

/** Select-option wording: carrier name併記 the actual carrier-billing service name. */
export const CARRIER_OPTION_LABELS: Record<CarrierId, string> = {
  docomo: 'ドコモ（ドコモ払い）',
  au: 'au（auかんたん決済）',
  softbank: 'ソフトバンク（ソフトバンクまとめて支払い）',
}

export const CARRIER_PHONE_REQUIRED_ERROR = '携帯電話番号を入力してください。'
export const CARRIER_PHONE_INVALID_ERROR =
  '070・080・090のいずれかで始まる11桁の番号を、ハイフンを含めて入力してください。'

// ---------------------------------------------------------------------------
// qr
// ---------------------------------------------------------------------------

export const QR_SERVICE_LABEL = 'サービス'
export const QR_CONTACT_LABEL = '登録電話番号またはID'
export const QR_CONTACT_PLACEHOLDER = '090-1234-5678 または ID'

export const QR_SERVICE_LABELS: Record<QrWalletId, string> = {
  paypay: 'PayPay',
  rakuten_pay: '楽天ペイ',
  d_barai: 'd払い',
  au_pay: 'au PAY',
  line_pay: 'LINE Pay',
  merpay: 'メルペイ',
}

export const QR_CONTACT_REQUIRED_ERROR = '登録電話番号またはIDを入力してください。'
export const QR_CONTACT_INVALID_ERROR = '1〜64文字で入力してください。'

// ---------------------------------------------------------------------------
// paypal / amazon_pay
// ---------------------------------------------------------------------------

export const PAYPAL_EMAIL_LABEL = 'PayPalアカウント（メールアドレス）'
export const AMAZON_PAY_EMAIL_LABEL = 'Amazonアカウント（メールアドレス）'
export const EXTERNAL_ACCOUNT_EMAIL_PLACEHOLDER = 'taro.yamada@example.com'

export const EXTERNAL_REDIRECT_NOTICE =
  '実際のサービスでは外部サイトへ遷移してログイン・認証を行いますが、本デモでは画面遷移は発生しません。'

export const EMAIL_REQUIRED_ERROR = 'メールアドレスを入力してください。'
export const EMAIL_INVALID_ERROR = '正しいメールアドレスを入力してください。'
