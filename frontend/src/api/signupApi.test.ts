/**
 * Unit tests for the registration API's error normalization and for the
 * Firestore read that stands in for the verification e-mail this project
 * never sends. The wizard's screen-level behaviour lives in
 * app/signupFlow.test.tsx; here the concern is only what each backend
 * refusal turns into for the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('firebase/functions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/functions')>()
  return {
    ...actual,
    getFunctions: vi.fn(actual.getFunctions),
    connectFunctionsEmulator: vi.fn(),
    httpsCallable: vi.fn(),
  }
})

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  return {
    ...actual,
    getFirestore: vi.fn(actual.getFirestore),
    connectFirestoreEmulator: vi.fn(),
    doc: vi.fn(),
    getDoc: vi.fn(),
  }
})

vi.mock('firebase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/auth')>()
  return {
    ...actual,
    getAuth: vi.fn(actual.getAuth),
    connectAuthEmulator: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
  }
})

import { FirebaseError } from 'firebase/app'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { isApiError } from './apiError'
import {
  EMAIL_NOT_VERIFIED_MESSAGE,
  VERIFICATION_CODES_COLLECTION,
  completeSignup,
  fetchVerificationCode,
  resendSignupCode,
  startSignup,
  verificationCodeDocumentId,
  verifySignupCode,
} from './signupApi'
import { EMPTY_REGISTRATION_DATA } from '../features/signup/signupTypes'

const EMAIL = 'taro@example.com'

/** Makes every httpsCallable(name) resolve/reject through one handler map. */
function mockCallables(handlers: Record<string, Mock>) {
  ;(httpsCallable as unknown as Mock).mockImplementation(
    (_functions: unknown, name: string) => handlers[name] ?? vi.fn().mockResolvedValue({ data: {} }),
  )
}

/** Builds a callable that always rejects with one FunctionsError code. */
function rejectingWith(code: string, details?: unknown): Mock {
  const error = new FirebaseError(`functions/${code}`, 'backend message')
  if (details !== undefined) Object.assign(error, { details })
  return vi.fn().mockRejectedValue(error)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verificationCodeDocumentId', () => {
  it('matches the backend normalisation (trimmed, lower-cased)', () => {
    expect(verificationCodeDocumentId('  Taro@Example.COM ')).toBe('taro@example.com')
  })
})

describe('startSignup / resendSignupCode', () => {
  it('asks the backend to issue a code and returns its status', async () => {
    const status = {
      email: EMAIL,
      expiresAt: 1,
      resendAvailableAt: 2,
      attemptsRemaining: 5,
      verified: false,
    }
    const startEmailVerification = vi.fn().mockResolvedValue({ data: status })
    mockCallables({ startEmailVerification })

    await expect(
      startSignup({ email: EMAIL, password: 'password123', name: '山田 太郎', nameKana: 'ヤマダ タロウ' }),
    ).resolves.toEqual(status)
    // Only the address is sent - the password never travels on this call.
    expect(startEmailVerification).toHaveBeenCalledWith({ email: EMAIL })
  })

  it('turns the resend cooldown into an actionable validation message', async () => {
    mockCallables({ resendEmailVerificationCode: rejectingWith('resource-exhausted') })

    await expect(resendSignupCode({ email: EMAIL })).rejects.toMatchObject({
      kind: 'validation',
      message: 'しばらく待ってから再送してください。',
    })
  })

  it('lets an unexpected resend failure keep its mapped kind', async () => {
    mockCallables({ resendEmailVerificationCode: rejectingWith('internal') })

    await expect(resendSignupCode({ email: EMAIL })).rejects.toMatchObject({ kind: 'server' })
  })
})

describe('verifySignupCode', () => {
  it('resolves for the right code', async () => {
    const verifyEmailCode = vi.fn().mockResolvedValue({ data: { verified: true, verifiedUntil: 1 } })
    mockCallables({ verifyEmailCode })

    await expect(verifySignupCode({ email: EMAIL, code: '481625' })).resolves.toBeUndefined()
    expect(verifyEmailCode).toHaveBeenCalledWith({ email: EMAIL, code: '481625' })
  })

  it.each([
    ['not-found', '認証コードが発行されていません。認証コードを再送してください。'],
    ['failed-precondition', '認証コードの有効期限が切れています。認証コードを再送してください。'],
    ['resource-exhausted', '認証の試行回数が上限に達しました。認証コードを再送してください。'],
    ['invalid-argument', '認証コードが正しくありません。'],
  ])('maps %s onto its own wording, as a validation error', async (code, message) => {
    mockCallables({ verifyEmailCode: rejectingWith(code) })

    // The verify screen only renders `message` for kind 'validation', so
    // every expected refusal has to arrive as one or it reads as a generic
    // "try again later".
    await expect(verifySignupCode({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      kind: 'validation',
      message,
    })
  })

  it('appends the remaining attempts the backend reports in details', async () => {
    mockCallables({ verifyEmailCode: rejectingWith('invalid-argument', { attemptsRemaining: 3 }) })

    await expect(verifySignupCode({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      message: '認証コードが正しくありません。（あと3回）',
    })
  })

  it('omits the suffix once no attempts are left', async () => {
    mockCallables({ verifyEmailCode: rejectingWith('invalid-argument', { attemptsRemaining: 0 }) })

    await expect(verifySignupCode({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      message: '認証コードが正しくありません。',
    })
  })

  it('keeps an unmapped code as its mapped kind rather than inventing wording', async () => {
    mockCallables({ verifyEmailCode: rejectingWith('unavailable') })

    await expect(verifySignupCode({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

describe('fetchVerificationCode', () => {
  it('reads the code out of verificationCodes/{normalised email}', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      data: () => ({ code: '481625' }),
    } as unknown as Awaited<ReturnType<typeof getDoc>>)

    await expect(fetchVerificationCode('  Taro@Example.COM ')).resolves.toBe('481625')
    expect(doc).toHaveBeenCalledWith(expect.anything(), VERIFICATION_CODES_COLLECTION, EMAIL)
  })

  it('returns null for a missing document instead of throwing', async () => {
    vi.mocked(getDoc).mockResolvedValue({
      data: () => undefined,
    } as unknown as Awaited<ReturnType<typeof getDoc>>)

    await expect(fetchVerificationCode(EMAIL)).resolves.toBeNull()
  })

  it('returns null when the read is denied, so the step degrades instead of breaking', async () => {
    vi.mocked(getDoc).mockRejectedValue(new FirebaseError('firestore/permission-denied', 'denied'))

    await expect(fetchVerificationCode(EMAIL)).resolves.toBeNull()
  })

  it('never issues a read for an address that is not a valid document id', async () => {
    await expect(fetchVerificationCode('a/b@example.com')).resolves.toBeNull()
    await expect(fetchVerificationCode('   ')).resolves.toBeNull()
    expect(getDoc).not.toHaveBeenCalled()
  })
})

describe('completeSignup', () => {
  it('explains an unverified address rather than showing a generic failure', async () => {
    mockCallables({ registerWithEmailPassword: rejectingWith('failed-precondition') })

    const error = await completeSignup({
      ...EMPTY_REGISTRATION_DATA,
      email: EMAIL,
      password: 'password123',
    }).catch((thrown: unknown) => thrown)

    expect(isApiError(error) && error.kind).toBe('validation')
    expect(isApiError(error) && error.message).toBe(EMAIL_NOT_VERIFIED_MESSAGE)
  })
})
