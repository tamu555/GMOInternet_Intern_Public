/**
 * Ordered catalogue of the 8 supported (dummy) payment methods, rendered by
 * `PaymentMethodSelector`. Kept as one data array (mirrors
 * `features/domains/tldData.ts`) so the display order and copy live in one
 * place.
 */
import type { ComponentType } from 'react'
import { CreditCard, Landmark, QrCode, Repeat, ShoppingBag, Smartphone, Store, Wallet } from 'lucide-react'
import type { PaymentMethodId } from './paymentTypes'
import {
  METHOD_LABEL_AMAZON_PAY,
  METHOD_LABEL_BANK_TRANSFER,
  METHOD_LABEL_CARRIER,
  METHOD_LABEL_CONVENIENCE_STORE,
  METHOD_LABEL_CREDIT_CARD,
  METHOD_LABEL_DIRECT_DEBIT,
  METHOD_LABEL_PAYPAL,
  METHOD_LABEL_QR,
  METHOD_SUMMARY_AMAZON_PAY,
  METHOD_SUMMARY_BANK_TRANSFER,
  METHOD_SUMMARY_CARRIER,
  METHOD_SUMMARY_CONVENIENCE_STORE,
  METHOD_SUMMARY_CREDIT_CARD,
  METHOD_SUMMARY_DIRECT_DEBIT,
  METHOD_SUMMARY_PAYPAL,
  METHOD_SUMMARY_QR,
} from './paymentMessages'

export type PaymentMethodCatalogEntry = {
  id: PaymentMethodId
  label: string
  summary: string
  icon: ComponentType<{ className?: string }>
}

export const PAYMENT_METHOD_CATALOG: readonly PaymentMethodCatalogEntry[] = [
  { id: 'credit_card', label: METHOD_LABEL_CREDIT_CARD, summary: METHOD_SUMMARY_CREDIT_CARD, icon: CreditCard },
  {
    id: 'convenience_store',
    label: METHOD_LABEL_CONVENIENCE_STORE,
    summary: METHOD_SUMMARY_CONVENIENCE_STORE,
    icon: Store,
  },
  { id: 'bank_transfer', label: METHOD_LABEL_BANK_TRANSFER, summary: METHOD_SUMMARY_BANK_TRANSFER, icon: Landmark },
  { id: 'direct_debit', label: METHOD_LABEL_DIRECT_DEBIT, summary: METHOD_SUMMARY_DIRECT_DEBIT, icon: Repeat },
  { id: 'carrier', label: METHOD_LABEL_CARRIER, summary: METHOD_SUMMARY_CARRIER, icon: Smartphone },
  { id: 'qr', label: METHOD_LABEL_QR, summary: METHOD_SUMMARY_QR, icon: QrCode },
  { id: 'paypal', label: METHOD_LABEL_PAYPAL, summary: METHOD_SUMMARY_PAYPAL, icon: Wallet },
  { id: 'amazon_pay', label: METHOD_LABEL_AMAZON_PAY, summary: METHOD_SUMMARY_AMAZON_PAY, icon: ShoppingBag },
] as const
