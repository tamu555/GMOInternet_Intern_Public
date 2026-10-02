/**
 * Registration-flow data model (新規登録 → メール認証 → 契約者情報 → 確認 → 完了).
 *
 * One flat object carried across every step (the shape the task fixed), held
 * by SignupProvider so screen-to-screen navigation never loses input.
 * `password` is transient: it lives only in memory and is excluded from the
 * sessionStorage draft (signupContext.ts) - a reload keeps everything else.
 *
 * `address`/`business` mirror the backend's `Address`/`BusinessInfo` shapes
 * (functions/src/auth/types.ts) field-for-field, since this is also what
 * gets sent over the wire via signupApi.ts's completeSignup.
 */
import type { AddressFormValues } from './addressSchema'

export type AccountType = 'individual' | 'sole-proprietor' | 'corporate'

export type Gender = 'male' | 'female' | 'other' | 'no_answer'

export type Address = AddressFormValues

export type BusinessInfo = {
  /** 会社名 for corporate, 屋号 (relabeled in the UI only) for sole-proprietor. */
  companyName: string
  /** '' when not provided - converted to `null` only at the API boundary (signupApi.ts). */
  department: string
  /** 担当者名 (corporate and sole-proprietor only). */
  contactPerson: string
}

export type RegistrationData = {
  email: string
  password: string

  accountType: AccountType

  name: string
  nameKana: string

  phoneNumber: string
  dateOfBirth: string
  gender: Gender
  newsletterOptIn: boolean

  /** Non-null iff accountType !== 'individual'. */
  business: BusinessInfo | null

  address: Address
}

export const EMPTY_ADDRESS: Address = {
  country: 'JP',
  postalCode: '',
  prefecture: '',
  city: '',
  addressLine: '',
  building: '',
}

export const EMPTY_REGISTRATION_DATA: RegistrationData = {
  email: '',
  password: '',
  accountType: 'individual',
  name: '',
  nameKana: '',
  phoneNumber: '',
  dateOfBirth: '',
  gender: 'no_answer',
  newsletterOptIn: false,
  business: null,
  address: EMPTY_ADDRESS,
}

export type SignupStepId = 'account' | 'verify' | 'contract' | 'confirm' | 'complete'

/** Stepper definition: 1 アカウント作成 → 2 メール認証 → 3 契約者情報 → 4 内容確認. */
export const SIGNUP_STEPS: { id: SignupStepId; label: string }[] = [
  { id: 'account', label: 'アカウント作成' },
  { id: 'verify', label: 'メール認証' },
  { id: 'contract', label: '契約者情報' },
  { id: 'confirm', label: '内容確認' },
]
