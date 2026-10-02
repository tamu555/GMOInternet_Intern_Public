/**
 * Renders the input fields for whichever payment method is currently
 * selected. Every control goes through `Field` so hints/errors get
 * `aria-describedby` + `role="alert"` wiring for free. Selects are native
 * `<select>` elements (styled via `NATIVE_SELECT_CLASS`) so flow tests can
 * drive them with `userEvent.selectOptions`.
 */
import { Field } from '@/components/Field'
import { Input } from '@/components/ui/input'
import { NATIVE_SELECT_CLASS } from '@/components/nativeSelect'
import { detectCardBrand, expectedCvcLength, formatCardExpiry, formatCardNumber } from './cardUtils'
import {
  ACCOUNT_TYPE_OPTIONS,
  BANK_OPTIONS,
  CARRIER_OPTIONS,
  CONVENIENCE_STORE_OPTIONS,
  INSTALLMENT_OPTIONS,
  QR_SERVICE_OPTIONS,
} from './paymentModel'
import {
  AMAZON_PAY_EMAIL_LABEL,
  BANK_TRANSFER_DATE_HINT,
  BANK_TRANSFER_DATE_LABEL,
  BANK_TRANSFER_DESTINATION_ACCOUNT_NUMBER,
  BANK_TRANSFER_DESTINATION_BANK,
  BANK_TRANSFER_DESTINATION_HEADING,
  BANK_TRANSFER_DESTINATION_HOLDER,
  BANK_TRANSFER_PAYER_KANA_LABEL,
  CARD_CVC_LABEL,
  CARD_EXPIRY_LABEL,
  CARD_EXPIRY_PLACEHOLDER,
  CARD_HOLDER_HINT,
  CARD_HOLDER_LABEL,
  CARD_HOLDER_PLACEHOLDER,
  CARD_INSTALLMENTS_LABEL,
  CARD_NUMBER_LABEL,
  CARD_NUMBER_PLACEHOLDER,
  CARRIER_LABEL,
  CARRIER_PHONE_LABEL,
  CARRIER_PHONE_PLACEHOLDER,
  CVS_CHAIN_LABEL,
  CVS_KANA_LABEL,
  CVS_KANA_PLACEHOLDER,
  CVS_PHONE_LABEL,
  CVS_PHONE_PLACEHOLDER,
  DIRECT_DEBIT_ACCOUNT_KANA_LABEL,
  DIRECT_DEBIT_ACCOUNT_NUMBER_LABEL,
  DIRECT_DEBIT_ACCOUNT_TYPE_LABEL,
  DIRECT_DEBIT_BANK_LABEL,
  DIRECT_DEBIT_BRANCH_CODE_LABEL,
  EXTERNAL_ACCOUNT_EMAIL_PLACEHOLDER,
  EXTERNAL_REDIRECT_NOTICE,
  PAYPAL_EMAIL_LABEL,
  QR_CONTACT_LABEL,
  QR_CONTACT_PLACEHOLDER,
  QR_SERVICE_LABEL,
} from './paymentMessages'
import type {
  AmazonPayValues,
  BankTransferValues,
  CarrierValues,
  ConvenienceStoreValues,
  CreditCardValues,
  DirectDebitValues,
  PayPalValues,
  PaymentFormErrors,
  PaymentFormValues,
  QrValues,
} from './paymentTypes'

function CreditCardFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: CreditCardValues
  errors: PaymentFormErrors['creditCard']
  onChange: (next: CreditCardValues) => void
  disabled?: boolean
}) {
  const brand = detectCardBrand(values.cardNumber)
  const cvcMaxLength = expectedCvcLength(brand)

  return (
    <div className="space-y-5">
      <Field label={CARD_NUMBER_LABEL} controlId={`${idPrefix}-card-number`} error={errors?.cardNumber}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            className="font-en"
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder={CARD_NUMBER_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.cardNumber ? true : undefined}
            value={values.cardNumber}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, cardNumber: formatCardNumber(event.target.value) })}
          />
        )}
      </Field>

      <div className="flex gap-2">
        <div className="flex-1 basis-32">
          <Field label={CARD_EXPIRY_LABEL} controlId={`${idPrefix}-card-expiry`} error={errors?.expiry}>
            {({ controlId, describedBy }) => (
              <Input
                id={controlId}
                className="font-en"
                type="text"
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder={CARD_EXPIRY_PLACEHOLDER}
                aria-describedby={describedBy}
                aria-invalid={errors?.expiry ? true : undefined}
                value={values.expiry}
                disabled={disabled}
                onChange={(event) => onChange({ ...values, expiry: formatCardExpiry(event.target.value) })}
              />
            )}
          </Field>
        </div>
        <div className="flex-1 basis-32">
          <Field label={CARD_CVC_LABEL} controlId={`${idPrefix}-card-cvc`} error={errors?.cvc}>
            {({ controlId, describedBy }) => (
              <Input
                id={controlId}
                className="font-en"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={cvcMaxLength}
                aria-describedby={describedBy}
                aria-invalid={errors?.cvc ? true : undefined}
                value={values.cvc}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...values, cvc: event.target.value.replace(/\D/g, '').slice(0, cvcMaxLength) })
                }
              />
            )}
          </Field>
        </div>
      </div>

      <Field
        label={CARD_HOLDER_LABEL}
        controlId={`${idPrefix}-card-holder`}
        hint={CARD_HOLDER_HINT}
        error={errors?.holderName}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="text"
            autoComplete="cc-name"
            placeholder={CARD_HOLDER_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.holderName ? true : undefined}
            value={values.holderName}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, holderName: event.target.value })}
          />
        )}
      </Field>

      <Field label={CARD_INSTALLMENTS_LABEL} controlId={`${idPrefix}-card-installments`}>
        {({ controlId, describedBy }) => (
          <select
            id={controlId}
            className={`${NATIVE_SELECT_CLASS} w-full`}
            aria-describedby={describedBy}
            value={values.installments}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, installments: event.target.value as CreditCardValues['installments'] })
            }
          >
            {INSTALLMENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  )
}

function ConvenienceStoreFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: ConvenienceStoreValues
  errors: PaymentFormErrors['convenienceStore']
  onChange: (next: ConvenienceStoreValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field label={CVS_CHAIN_LABEL} controlId={`${idPrefix}-cvs-chain`}>
        {({ controlId, describedBy }) => (
          <select
            id={controlId}
            className={`${NATIVE_SELECT_CLASS} w-full`}
            aria-describedby={describedBy}
            value={values.chain}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, chain: event.target.value as ConvenienceStoreValues['chain'] })
            }
          >
            {CONVENIENCE_STORE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={CVS_KANA_LABEL} controlId={`${idPrefix}-cvs-kana`} error={errors?.kana}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="text"
            placeholder={CVS_KANA_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.kana ? true : undefined}
            value={values.kana}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, kana: event.target.value })}
          />
        )}
      </Field>

      <Field label={CVS_PHONE_LABEL} controlId={`${idPrefix}-cvs-phone`} error={errors?.phone}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            className="font-en"
            type="tel"
            autoComplete="tel"
            placeholder={CVS_PHONE_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.phone ? true : undefined}
            value={values.phone}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, phone: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

function BankTransferFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: BankTransferValues
  errors: PaymentFormErrors['bankTransfer']
  onChange: (next: BankTransferValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field label={BANK_TRANSFER_PAYER_KANA_LABEL} controlId={`${idPrefix}-bank-payer-kana`} error={errors?.payerKana}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="text"
            aria-describedby={describedBy}
            aria-invalid={errors?.payerKana ? true : undefined}
            value={values.payerKana}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, payerKana: event.target.value })}
          />
        )}
      </Field>

      <Field
        label={BANK_TRANSFER_DATE_LABEL}
        controlId={`${idPrefix}-bank-transfer-date`}
        hint={BANK_TRANSFER_DATE_HINT}
        error={errors?.transferDate}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="date"
            aria-describedby={describedBy}
            aria-invalid={errors?.transferDate ? true : undefined}
            value={values.transferDate}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, transferDate: event.target.value })}
          />
        )}
      </Field>

      <div className="space-y-1 bg-grass-1 px-3.5 py-3 text-sm">
        <p className="font-medium">{BANK_TRANSFER_DESTINATION_HEADING}</p>
        <p className="text-muted-foreground">{BANK_TRANSFER_DESTINATION_BANK}</p>
        <p className="font-en text-muted-foreground">{BANK_TRANSFER_DESTINATION_ACCOUNT_NUMBER}</p>
        <p className="text-muted-foreground">{BANK_TRANSFER_DESTINATION_HOLDER}</p>
      </div>
    </div>
  )
}

function DirectDebitFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: DirectDebitValues
  errors: PaymentFormErrors['directDebit']
  onChange: (next: DirectDebitValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field label={DIRECT_DEBIT_BANK_LABEL} controlId={`${idPrefix}-debit-bank`}>
        {({ controlId, describedBy }) => (
          <select
            id={controlId}
            className={`${NATIVE_SELECT_CLASS} w-full`}
            aria-describedby={describedBy}
            value={values.bank}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, bank: event.target.value as DirectDebitValues['bank'] })}
          >
            {BANK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <div className="flex gap-2">
        <div className="flex-1 basis-32">
          <Field
            label={DIRECT_DEBIT_BRANCH_CODE_LABEL}
            controlId={`${idPrefix}-debit-branch`}
            error={errors?.branchCode}
          >
            {({ controlId, describedBy }) => (
              <Input
                id={controlId}
                className="font-en"
                type="text"
                inputMode="numeric"
                maxLength={3}
                aria-describedby={describedBy}
                aria-invalid={errors?.branchCode ? true : undefined}
                value={values.branchCode}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...values, branchCode: event.target.value.replace(/\D/g, '').slice(0, 3) })
                }
              />
            )}
          </Field>
        </div>
        <div className="flex-1 basis-32">
          <Field label={DIRECT_DEBIT_ACCOUNT_TYPE_LABEL} controlId={`${idPrefix}-debit-account-type`}>
            {({ controlId, describedBy }) => (
              <select
                id={controlId}
                className={`${NATIVE_SELECT_CLASS} w-full`}
                aria-describedby={describedBy}
                value={values.accountType}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...values, accountType: event.target.value as DirectDebitValues['accountType'] })
                }
              >
                {ACCOUNT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </div>

      <Field
        label={DIRECT_DEBIT_ACCOUNT_NUMBER_LABEL}
        controlId={`${idPrefix}-debit-account-number`}
        error={errors?.accountNumber}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            className="font-en"
            type="text"
            inputMode="numeric"
            maxLength={7}
            aria-describedby={describedBy}
            aria-invalid={errors?.accountNumber ? true : undefined}
            value={values.accountNumber}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...values, accountNumber: event.target.value.replace(/\D/g, '').slice(0, 7) })
            }
          />
        )}
      </Field>

      <Field
        label={DIRECT_DEBIT_ACCOUNT_KANA_LABEL}
        controlId={`${idPrefix}-debit-account-kana`}
        error={errors?.accountKana}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="text"
            aria-describedby={describedBy}
            aria-invalid={errors?.accountKana ? true : undefined}
            value={values.accountKana}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, accountKana: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

function CarrierFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: CarrierValues
  errors: PaymentFormErrors['carrier']
  onChange: (next: CarrierValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field label={CARRIER_LABEL} controlId={`${idPrefix}-carrier-name`}>
        {({ controlId, describedBy }) => (
          <select
            id={controlId}
            className={`${NATIVE_SELECT_CLASS} w-full`}
            aria-describedby={describedBy}
            value={values.carrier}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, carrier: event.target.value as CarrierValues['carrier'] })}
          >
            {CARRIER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={CARRIER_PHONE_LABEL} controlId={`${idPrefix}-carrier-phone`} error={errors?.phone}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            className="font-en"
            type="tel"
            autoComplete="tel"
            placeholder={CARRIER_PHONE_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.phone ? true : undefined}
            value={values.phone}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, phone: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

function QrFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: QrValues
  errors: PaymentFormErrors['qr']
  onChange: (next: QrValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field label={QR_SERVICE_LABEL} controlId={`${idPrefix}-qr-service`}>
        {({ controlId, describedBy }) => (
          <select
            id={controlId}
            className={`${NATIVE_SELECT_CLASS} w-full`}
            aria-describedby={describedBy}
            value={values.service}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, service: event.target.value as QrValues['service'] })}
          >
            {QR_SERVICE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={QR_CONTACT_LABEL} controlId={`${idPrefix}-qr-contact`} error={errors?.contact}>
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            className="font-en"
            type="text"
            placeholder={QR_CONTACT_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.contact ? true : undefined}
            value={values.contact}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, contact: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

function PayPalFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: PayPalValues
  errors: PaymentFormErrors['paypal']
  onChange: (next: PayPalValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field
        label={PAYPAL_EMAIL_LABEL}
        controlId={`${idPrefix}-paypal-email`}
        hint={EXTERNAL_REDIRECT_NOTICE}
        error={errors?.email}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="email"
            autoComplete="email"
            placeholder={EXTERNAL_ACCOUNT_EMAIL_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.email ? true : undefined}
            value={values.email}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, email: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

function AmazonPayFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: AmazonPayValues
  errors: PaymentFormErrors['amazonPay']
  onChange: (next: AmazonPayValues) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-5">
      <Field
        label={AMAZON_PAY_EMAIL_LABEL}
        controlId={`${idPrefix}-amazon-pay-email`}
        hint={EXTERNAL_REDIRECT_NOTICE}
        error={errors?.email}
      >
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            type="email"
            autoComplete="email"
            placeholder={EXTERNAL_ACCOUNT_EMAIL_PLACEHOLDER}
            aria-describedby={describedBy}
            aria-invalid={errors?.email ? true : undefined}
            value={values.email}
            disabled={disabled}
            onChange={(event) => onChange({ ...values, email: event.target.value })}
          />
        )}
      </Field>
    </div>
  )
}

export function PaymentMethodFields({
  idPrefix,
  values,
  errors,
  onChange,
  disabled,
}: {
  idPrefix: string
  values: PaymentFormValues
  errors: PaymentFormErrors
  onChange: (next: PaymentFormValues) => void
  disabled?: boolean
}) {
  switch (values.method) {
    case 'credit_card':
      return (
        <CreditCardFields
          idPrefix={idPrefix}
          values={values.creditCard}
          errors={errors.creditCard}
          onChange={(creditCard) => onChange({ ...values, creditCard })}
          disabled={disabled}
        />
      )
    case 'convenience_store':
      return (
        <ConvenienceStoreFields
          idPrefix={idPrefix}
          values={values.convenienceStore}
          errors={errors.convenienceStore}
          onChange={(convenienceStore) => onChange({ ...values, convenienceStore })}
          disabled={disabled}
        />
      )
    case 'bank_transfer':
      return (
        <BankTransferFields
          idPrefix={idPrefix}
          values={values.bankTransfer}
          errors={errors.bankTransfer}
          onChange={(bankTransfer) => onChange({ ...values, bankTransfer })}
          disabled={disabled}
        />
      )
    case 'direct_debit':
      return (
        <DirectDebitFields
          idPrefix={idPrefix}
          values={values.directDebit}
          errors={errors.directDebit}
          onChange={(directDebit) => onChange({ ...values, directDebit })}
          disabled={disabled}
        />
      )
    case 'carrier':
      return (
        <CarrierFields
          idPrefix={idPrefix}
          values={values.carrier}
          errors={errors.carrier}
          onChange={(carrier) => onChange({ ...values, carrier })}
          disabled={disabled}
        />
      )
    case 'qr':
      return (
        <QrFields
          idPrefix={idPrefix}
          values={values.qr}
          errors={errors.qr}
          onChange={(qr) => onChange({ ...values, qr })}
          disabled={disabled}
        />
      )
    case 'paypal':
      return (
        <PayPalFields
          idPrefix={idPrefix}
          values={values.paypal}
          errors={errors.paypal}
          onChange={(paypal) => onChange({ ...values, paypal })}
          disabled={disabled}
        />
      )
    case 'amazon_pay':
      return (
        <AmazonPayFields
          idPrefix={idPrefix}
          values={values.amazonPay}
          errors={errors.amazonPay}
          onChange={(amazonPay) => onChange({ ...values, amazonPay })}
          disabled={disabled}
        />
      )
    default:
      return null
  }
}
