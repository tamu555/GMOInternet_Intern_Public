/**
 * Public surface of the dummy (疑似) payment feature. Callers outside this
 * folder must import only from here — never a deep import into
 * `paymentModel`, `cardUtils`, `PaymentMethodFields`, etc.
 */
export { PaymentSection } from './PaymentSection'
export { buildInitialPaymentValues, describePayment, isPaymentComplete, validatePayment } from './paymentModel'
export type { PaymentFormErrors, PaymentFormValues, PaymentMethodId } from './paymentTypes'
