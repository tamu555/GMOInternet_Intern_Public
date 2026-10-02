/**
 * My-page profile view/edit & account deletion (docs/仕様/auth.md §4.8).
 *
 * Three Callables through the shared `invoke()` seam (api/callable.ts):
 *   - `getMyProfile` / `updateMyProfile`: read/write the caller's own
 *     `UserProfile` (functions/src/auth/types.ts, functions/src/auth/
 *     profileSchema.ts).
 *   - `deleteAccountWithPassword` / `deleteAccountWithGoogle`: §4.8. Call
 *     ONLY immediately after a fresh client-side reauthentication
 *     (auth/reauth.ts) - the backend rejects a stale ID token
 *     (`auth_time` older than 5 min) with `failed-precondition`.
 *
 * Wire shapes mirror `functions/src/auth/types.ts`'s `UserProfile`/`Address`/
 * `BusinessInfo` field-for-field: optional free-text fields are `string |
 * null` on the wire, not the edit form's `''` sentinel (contractSchema.ts /
 * addressSchema.ts) - `contractFormToProfilePayload` and
 * `profileToFormDefaults` are the two conversions at this boundary, mirroring
 * signupApi.ts's `toAddressPayload`/`toBusinessPayload` (reused directly
 * below, same rule, same call sites' pattern).
 */
import { invoke } from './callable'
import { toAddressPayload, toBusinessPayload } from './signupApi'
import type { ContractFormValues } from '../features/signup/contractSchema'
import type { BusinessInfo } from '../features/signup/signupTypes'

export type WireAuthProvider = 'password' | 'google.com'
export type WireAccountStatus = 'pending_additional_info' | 'active' | 'pending_deletion' | 'purging'

export type WireJapanAddress = {
  country: 'JP'
  postalCode: string
  prefecture: string
  city: string
  addressLine: string
  building: string | null
}

export type WireInternationalAddress = {
  country: 'US' | 'GB' | 'CN' | 'KR' | 'TW'
  postalCode: string
  state: string | null
  city: string
  addressLine1: string
  addressLine2: string | null
}

export type WireAddress = WireJapanAddress | WireInternationalAddress

export type WireBusinessInfo = {
  companyName: string
  department: string | null
  contactPerson: string
}

export type WireUserProfile = {
  name: string
  nameKana: string
  phoneNumber: string
  dateOfBirth: string
  gender: 'male' | 'female' | 'other' | 'no_answer'
  newsletterOptIn: boolean
  accountType: 'individual' | 'sole-proprietor' | 'corporate'
  /** Non-null iff accountType !== 'individual'. */
  business: WireBusinessInfo | null
  address: WireAddress
}

export type MyProfile = {
  uid: string
  email: string
  authProvider: WireAuthProvider
  status: WireAccountStatus
  /** null only while status === 'pending_additional_info'. */
  profile: WireUserProfile | null
  createdAt: string
  updatedAt: string
}

export async function getMyProfile(): Promise<MyProfile> {
  return invoke<Record<string, never>, MyProfile>('getMyProfile', {})
}

/** Edit form values (contractSchema.ts's shape) -> the updateMyProfile wire payload. */
export function contractFormToProfilePayload(values: ContractFormValues): unknown {
  const { companyName, department, contactPerson, address, ...rest } = values
  const business: BusinessInfo | null =
    values.accountType === 'individual'
      ? null
      : { companyName: companyName ?? '', department: department ?? '', contactPerson: contactPerson ?? '' }
  return { ...rest, address: toAddressPayload(address), business: toBusinessPayload(business) }
}

export async function updateMyProfile(values: ContractFormValues): Promise<MyProfile> {
  return invoke<{ profile: unknown }, MyProfile>('updateMyProfile', {
    profile: contractFormToProfilePayload(values),
  })
}

/** Wire profile -> editable form defaults ('' sentinel instead of null, per addressSchema.ts's own doc comment on why). */
export function profileToFormDefaults(profile: WireUserProfile): ContractFormValues {
  const address: ContractFormValues['address'] =
    profile.address.country === 'JP'
      ? { ...profile.address, building: profile.address.building ?? '' }
      : { ...profile.address, state: profile.address.state ?? '', addressLine2: profile.address.addressLine2 ?? '' }
  return {
    accountType: profile.accountType,
    name: profile.name,
    nameKana: profile.nameKana,
    companyName: profile.business?.companyName ?? '',
    department: profile.business?.department ?? '',
    contactPerson: profile.business?.contactPerson ?? '',
    phoneNumber: profile.phoneNumber,
    dateOfBirth: profile.dateOfBirth,
    gender: profile.gender,
    newsletterOptIn: profile.newsletterOptIn,
    address,
  }
}

/** §4.8.1. Call only right after `reauthenticateWithPassword` (auth/reauth.ts) succeeded. */
export async function deleteAccountWithPassword(): Promise<void> {
  await invoke<Record<string, never>, unknown>('deleteAccountWithPassword', {})
}

/** §4.8.2. Call only right after `reauthenticateWithGoogle` (auth/reauth.ts) succeeded. */
export async function deleteAccountWithGoogle(): Promise<void> {
  await invoke<Record<string, never>, unknown>('deleteAccountWithGoogle', {})
}
