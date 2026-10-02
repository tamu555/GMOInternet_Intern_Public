/**
 * Google additional-info form schema (GoogleAdditionalInfoPage.tsx).
 *
 * The full profile minus email/password is exactly what contractSchema.ts
 * already validates (account type, name/nameKana, phone/DOB/gender/
 * newsletter, business, country-conditional address) - matching the
 * backend's `additionalInfoInputSchema`, which is `profileSchema` with no
 * email/password fields either. Reused directly, not duplicated.
 */
export { contractSchema as additionalInfoSchema, GENDERS } from './contractSchema'
export type { ContractFormValues as AdditionalInfoFormValues } from './contractSchema'
