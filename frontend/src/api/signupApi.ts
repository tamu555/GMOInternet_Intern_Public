/**
 * Registration-flow API (新規登録ウィザード).
 *
 * Flow contract:
 *   1. startSignup / verifySignupCode / resendSignupCode - Step 2's 6-digit
 *      code, issued and checked server-side by the `startEmailVerification`
 *      / `verifyEmailCode` / `resendEmailVerificationCode` Callables against
 *      the `verificationCodes/{email}` document.
 *   2. completeSignup - the real registration path. Creates the Firebase
 *      Auth user + Firestore profile via the `registerWithEmailPassword`
 *      Callable, then signs the browser in and establishes the Cookie
 *      session (`sessionLogin`). Does not return a session/user - the caller
 *      (SignupConfirmPage) calls useAuth().recheckSession() afterward.
 *      The backend refuses it unless step 1 -> step 2 actually happened, so
 *      the wizard's order is a server-side precondition, not a UI courtesy.
 *
 * Delivery note: nothing in this project sends mail, so the code travels
 * through Firestore instead of an inbox and firestore.rules allows a single
 * unauthenticated `get` on that document. The Callables themselves never
 * return the code, and the wizard never renders it - `fetchVerificationCode`
 * is the client-side read that rule exists for, kept here as the one
 * supported way in rather than being open-coded at a call site.
 */
import { httpsCallable } from 'firebase/functions'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { FirebaseError } from 'firebase/app'
import { auth, firestore, functions } from '../firebase/client'
import { mapAuthError, mapCallableError } from '../firebase/errors'
import { ApiError } from './apiError'
import { issueCsrfToken, sessionLogin } from './sessionApi'
import type { Address, BusinessInfo, RegistrationData } from '../features/signup/signupTypes'

/** Matches functions/src/config/firebase.ts COLLECTIONS.verificationCodes. */
export const VERIFICATION_CODES_COLLECTION = 'verificationCodes'

/**
 * The document id the backend writes under (see
 * functions/src/auth/verificationCodes.ts `normaliseVerificationEmail`).
 * Both sides have to agree on one spelling or the lookup misses.
 */
export function verificationCodeDocumentId(email: string): string {
  return email.trim().toLowerCase()
}

export type StartSignupInput = {
  email: string
  password: string
  name: string
  nameKana: string
}

/** What the three verification Callables answer. Never carries the code. */
export type VerificationStatus = {
  email: string
  expiresAt: number
  resendAvailableAt: number
  attemptsRemaining: number
  verified: boolean
}

async function callVerification(name: string, payload: unknown): Promise<unknown> {
  try {
    const result = await httpsCallable(functions, name)(payload)
    return result.data
  } catch (error) {
    throw mapCallableError(error)
  }
}

/** Step 1 submit: asks the backend to issue (or keep) a code for this address. */
export async function startSignup(input: StartSignupInput): Promise<VerificationStatus> {
  return (await callVerification('startEmailVerification', {
    email: input.email,
  })) as VerificationStatus
}

const RESEND_TOO_SOON_MESSAGE = 'しばらく待ってから再送してください。'

export async function resendSignupCode(input: { email: string }): Promise<VerificationStatus> {
  try {
    return (await callVerification('resendEmailVerificationCode', {
      email: input.email,
    })) as VerificationStatus
  } catch (error) {
    // `resource-exhausted` (the 60-second cooldown) maps to a bare 'server'
    // kind, which would tell the visitor to try again later without saying
    // that waiting is exactly what fixes it.
    if (error instanceof ApiError && error.code === 'resource-exhausted') {
      throw new ApiError({ kind: 'validation', status: 429, message: RESEND_TOO_SOON_MESSAGE })
    }
    throw error
  }
}

/**
 * Backend refusal -> the sentence shown under the code input. The screen
 * only surfaces `message` for `kind: 'validation'`, so every expected
 * outcome is normalized to that kind with a wording of its own; anything
 * unexpected keeps its mapped kind and falls back to the generic message.
 */
const VERIFY_ERROR_MESSAGE: Readonly<Record<string, string>> = {
  'invalid-argument': '認証コードが正しくありません。',
  'not-found': '認証コードが発行されていません。認証コードを再送してください。',
  'failed-precondition': '認証コードの有効期限が切れています。認証コードを再送してください。',
  'resource-exhausted': '認証の試行回数が上限に達しました。認証コードを再送してください。',
}

/** The backend puts the remaining attempt count in the error's `details`. */
function remainingAttempts(error: unknown): number | null {
  if (!(error instanceof FirebaseError)) return null
  const details = (error as { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return null
  const value = (details as { attemptsRemaining?: unknown }).attemptsRemaining
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toVerifyError(error: unknown): ApiError {
  const mapped = mapCallableError(error)
  const message = mapped.code ? VERIFY_ERROR_MESSAGE[mapped.code] : undefined
  if (!message) return mapped

  const attempts = remainingAttempts(error)
  const suffix = attempts !== null && attempts > 0 ? `（あと${attempts}回）` : ''
  return new ApiError({ kind: 'validation', status: 400, message: `${message}${suffix}`, code: mapped.code })
}

export async function verifySignupCode(input: { email: string; code: string }): Promise<void> {
  try {
    await httpsCallable(functions, 'verifyEmailCode')(input)
  } catch (error) {
    throw toVerifyError(error)
  }
}

/**
 * Reads the code that was issued for this address.
 *
 * Only possible because firestore.rules deliberately allows an
 * unauthenticated `get` on this one collection - the substitute for the mail
 * this project never sends. Deliberately NOT called by SignupVerifyPage:
 * rendering the code would hand it to anyone looking at the screen. Returns
 * null rather than throwing when the document is absent or unreadable, so a
 * caller degrades instead of breaking.
 */
export async function fetchVerificationCode(email: string): Promise<string | null> {
  const id = verificationCodeDocumentId(email)
  // A slash would address a subcollection instead of a document, which the
  // SDK rejects by throwing - the backend refuses such addresses too.
  if (id.length === 0 || id.includes('/')) return null

  try {
    const snapshot = await getDoc(doc(firestore, VERIFICATION_CODES_COLLECTION, id))
    const code = snapshot.data()?.code
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

export type CompleteSignupInput = RegistrationData

/**
 * Shown when the wizard reaches 確認 without the in-memory password (a reload
 * drops it while the rest of the draft survives - see SignupProvider.tsx).
 * useSignupGate normally redirects before that happens; this is the backstop
 * so the visitor never sees the backend's opaque `invalid-argument` instead.
 */
export const PASSWORD_LOST_MESSAGE =
  'セキュリティのためパスワードは保持されません。お手数ですが最初からやり直してください。'

/**
 * '' (the form/state sentinel for "not provided") -> `null`, matching the
 * backend's `string | null` optional fields. Shared with
 * GoogleAdditionalInfoPage.tsx's `submitAdditionalInfo` call, which needs
 * the exact same normalization for the exact same leaf schemas.
 */
export function nullifyEmpty(value: string): string | null {
  return value.length > 0 ? value : null
}

export function toAddressPayload(address: Address): unknown {
  if (address.country === 'JP') {
    return { ...address, building: nullifyEmpty(address.building) }
  }
  return { ...address, state: nullifyEmpty(address.state), addressLine2: nullifyEmpty(address.addressLine2) }
}

export function toBusinessPayload(business: BusinessInfo | null): unknown {
  if (!business) return null
  return { ...business, department: nullifyEmpty(business.department) }
}

type RegistrationInput = Omit<RegistrationData, 'password' | 'address' | 'business'> & {
  password: string
  address: unknown
  business: unknown
}

function toRegistrationPayload(input: CompleteSignupInput): RegistrationInput {
  const { address, business, ...profile } = input
  return { ...profile, address: toAddressPayload(address), business: toBusinessPayload(business) }
}

/**
 * Shown when the backend refuses the registration because the address holds
 * no live verification grant - the code was never entered, or the 30-minute
 * window elapsed while the visitor was filling in 契約者情報.
 */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'メールアドレスの認証が完了していないか、有効期限が切れています。お手数ですが認証をやり直してください。'

export async function completeSignup(input: CompleteSignupInput): Promise<void> {
  if (input.password.length === 0) {
    throw new ApiError({ kind: 'validation', status: 400, message: PASSWORD_LOST_MESSAGE })
  }

  const registerWithEmailPassword = httpsCallable(functions, 'registerWithEmailPassword')
  try {
    await registerWithEmailPassword(toRegistrationPayload(input))
  } catch (error) {
    const mapped = mapCallableError(error)
    if (mapped.code === 'failed-precondition') {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: EMAIL_NOT_VERIFIED_MESSAGE,
        code: mapped.code,
      })
    }
    throw mapped
  }

  try {
    await signInWithEmailAndPassword(auth, input.email, input.password)
  } catch (error) {
    throw mapAuthError(error)
  }

  const { csrfToken } = await issueCsrfToken()
  const idToken = await auth.currentUser?.getIdToken()
  if (!idToken) {
    throw new ApiError({ kind: 'server', status: 0 })
  }
  const result = await sessionLogin({ idToken, csrfToken })
  if (result.status !== 'ok') {
    throw new ApiError({ kind: 'server', status: 0 })
  }
}
