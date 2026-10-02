/**
 * Integration tests for the registration wizard:
 * 新規登録 (/signup) → メール認証 → 契約者情報 → 内容確認 → 登録完了 →
 * マイページ, driven through the real router.
 *
 * Rewritten for the full-profile-registration feature: the backend is now
 * real Firebase (Auth SDK + `registerWithEmailPassword`/session Callables),
 * not MSW-mocked REST, so this file mocks `firebase/auth`/`firebase/functions`
 * at the module level (architecture doc §1.6) and spies on `global.fetch` for
 * `sessionApi.ts`'s plain-fetch session calls, instead of using MSW's `server`.
 *
 * Step 2 (メール認証) is a network step too now (`startEmailVerification` /
 * `verifyEmailCode` Callables), so the `httpsCallable` mock dispatches per
 * function name instead of returning one handler for every call.
 * `firebase/firestore` is mocked only to keep module init inert - the screen
 * itself never reads the code (SignupVerifyPage.tsx).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('firebase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/auth')>()
  return {
    ...actual,
    getAuth: vi.fn(actual.getAuth),
    connectAuthEmulator: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    signInWithPopup: vi.fn(),
  }
})

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

import { FirebaseError } from 'firebase/app'
import { signInWithEmailAndPassword, signInWithPopup } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth } from '../firebase/client'
import { clearAccessToken } from '../auth/tokenStorage'
import { completeSignup } from '../api/signupApi'
import { EMPTY_REGISTRATION_DATA } from '../features/signup/signupTypes'
import { AppRouter } from './AppRouter'

/** The code the fake `verificationCodes/{email}` document holds. */
const ISSUED_CODE = '481625'

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

type UserSession = ReturnType<typeof userEvent.setup>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Installs the per-name `httpsCallable` dispatch plus the Firestore read
 * that backs the code the verify screen displays. Every test needs the two
 * verification Callables (step 2 is on the path to every later step), so
 * they are wired here rather than in each test.
 */
function mockCallables(overrides: Record<string, Mock> = {}) {
  const status = {
    email: 'taro@example.com',
    expiresAt: Date.now() + 600_000,
    resendAvailableAt: Date.now() + 60_000,
    attemptsRemaining: 5,
    verified: false,
  }
  const handlers: Record<string, Mock> = {
    startEmailVerification: vi.fn().mockResolvedValue({ data: status }),
    resendEmailVerificationCode: vi.fn().mockResolvedValue({ data: status }),
    verifyEmailCode: vi.fn().mockImplementation(async (payload: { code: string }) => {
      if (payload.code !== ISSUED_CODE) {
        throw new FirebaseError('functions/invalid-argument', 'The verification code is incorrect.')
      }
      return { data: { verified: true, verifiedUntil: Date.now() + 1_800_000 } }
    }),
    ...overrides,
  }
  // Callables this suite does not stub (listTlds on the top page, …) must
  // fail rather than resolve an empty payload: their screens are built to
  // survive an unreachable backend, not a well-formed but empty answer.
  ;(httpsCallable as unknown as Mock).mockImplementation(
    (_functions: unknown, name: string) =>
      handlers[name] ??
      vi.fn().mockRejectedValue(new FirebaseError('functions/unavailable', 'not stubbed in this test')),
  )
  return handlers
}

/** Registered user, id-token'd sign-in, and the session-cookie round trip - the happy path for completeSignup(). */
function mockSuccessfulRegistration() {
  const registerWithEmailPassword = vi.fn().mockResolvedValue({ data: { uid: 'uid-1', status: 'active' } })
  mockCallables({ registerWithEmailPassword })
  vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
    user: { getIdToken: vi.fn().mockResolvedValue('id-token') },
  } as unknown as Awaited<ReturnType<typeof signInWithEmailAndPassword>>)
  // signupApi.completeSignup() reads auth.currentUser (not the credential the
  // mock above resolves) to fetch the ID token for sessionLogin.
  vi.spyOn(auth, 'currentUser', 'get').mockReturnValue({
    getIdToken: vi.fn().mockResolvedValue('id-token'),
  } as unknown as typeof auth.currentUser)
  return registerWithEmailPassword
}

function mockConflictingRegistration() {
  const registerWithEmailPassword = vi
    .fn()
    .mockRejectedValue(new FirebaseError('functions/already-exists', 'このメールアドレスはすでに使用されています。'))
  mockCallables({ registerWithEmailPassword })
  return registerWithEmailPassword
}

async function fillAccountStep(user: UserSession, email = 'taro@example.com') {
  await user.type(await screen.findByLabelText('名前（漢字）'), '山田 太郎')
  await user.type(screen.getByLabelText('名前（カナ）'), 'ヤマダ タロウ')
  await user.type(screen.getByLabelText('メールアドレス'), email)
  await user.type(screen.getByLabelText('パスワード'), 'password123')
  await user.type(screen.getByLabelText('パスワード確認'), 'password123')
  await user.click(screen.getByRole('checkbox', { name: /利用規約/ }))
  await user.click(screen.getByRole('button', { name: '新規登録' }))
}

async function passEmailVerification(user: UserSession) {
  await user.type(await screen.findByLabelText('認証コード'), ISSUED_CODE)
  await user.click(screen.getByRole('button', { name: '認証する' }))
}

async function fillContactSection(user: UserSession) {
  await user.type(screen.getByLabelText('電話番号'), '090-1234-5678')
  await user.type(screen.getByLabelText('生年月日'), '1990-01-01')
  await user.type(screen.getByLabelText('郵便番号'), '100-0001')
  await user.selectOptions(screen.getByLabelText('都道府県'), '東京都')
  await user.type(screen.getByLabelText('市区町村'), '千代田区')
  await user.type(screen.getByLabelText('番地'), '千代田1-1-1')
}

/** Non-Japan branch: 居住国 switches 都道府県/番地/建物名 for 州・省/住所1・2行目. */
async function fillInternationalContactSection(user: UserSession, countryLabel = 'アメリカ合衆国') {
  await user.selectOptions(screen.getByLabelText('居住国'), countryLabel)
  await user.type(screen.getByLabelText('電話番号'), '+1-415-555-0100')
  await user.type(screen.getByLabelText('生年月日'), '1990-01-01')
  await user.type(screen.getByLabelText('郵便番号'), '94105')
  await user.type(screen.getByLabelText('州・省（任意）'), 'California')
  await user.type(screen.getByLabelText('市区町村'), 'San Francisco')
  await user.type(screen.getByLabelText('住所1行目'), '123 Main St')
  await user.type(screen.getByLabelText('住所2行目（任意）'), 'Apt 4B')
}

async function walkToContract(user: UserSession, email = 'taro@example.com') {
  renderApp('/signup')
  await fillAccountStep(user, email)
  await passEmailVerification(user)
  await screen.findByRole('heading', { name: '契約者情報の入力' })
}

beforeEach(() => {
  // vi.mock-created fns (signInWithEmailAndPassword, httpsCallable) are
  // module-level singletons whose call history vi.restoreAllMocks() (afterEach)
  // does not reset - clear it explicitly so one test's calls never leak into
  // the next test's `.not.toHaveBeenCalled()` assertions.
  vi.clearAllMocks()
  // Step 2 sits on the path to every later step, so its Callables and the
  // Firestore read behind the displayed code are wired for every test;
  // mockSuccessfulRegistration/mockConflictingRegistration re-install this
  // with their own registerWithEmailPassword on top.
  mockCallables()
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearAccessToken()
  // No Cookie session exists until completeSignup()'s own sessionLogin call
  // succeeds - tracked so the initial FIG.7 mount check 401s like a fresh
  // visitor, instead of every test starting out already authenticated.
  let sessionEstablished = false
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/session/csrf')) return jsonResponse({ csrfToken: 'csrf-token' })
    if (url.includes('/api/session/login')) {
      sessionEstablished = true
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/me')) {
      if (!sessionEstablished) return jsonResponse({ error: { code: 'unauthenticated', message: 'no session' } }, 401)
      return jsonResponse({ id: 'uid-1', email: 'taro@example.com', displayName: '山田 太郎' })
    }
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('signup entry', () => {
  it('reaches /signup from the header 会員登録 link and shows the stepper', async () => {
    const user = userEvent.setup()
    renderApp('/')

    // The footer sitemap links to /signup too; this test is about the header
    // entry point, so the query is scoped to the banner landmark.
    const header = within(await screen.findByRole('banner'))
    await user.click(header.getByRole('link', { name: '会員登録' }))

    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup')
    expect(screen.getByRole('navigation', { name: '登録の進行状況' })).toBeInTheDocument()
    expect(screen.getByText('アカウント作成')).toBeInTheDocument()
  })

  /* 2026-08-27 の報告「可視化ボタンが不可逆的」の実体は、この2欄が素の
     <input type="password"> で切り替えを一切持っていなかったこと。両方に
     付いていること、そして片方を開いてももう片方は隠れたままであることを
     ここで固定する（往復そのものは PasswordField.test.tsx が見ている）。 */
  it('gives both password fields an independent, reversible reveal toggle', async () => {
    const user = userEvent.setup()
    renderApp('/signup')

    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeInTheDocument()
    const password = screen.getByLabelText('パスワード')
    const confirm = screen.getByLabelText('パスワード確認')
    expect(password).toHaveAttribute('type', 'password')
    expect(confirm).toHaveAttribute('type', 'password')

    const toggles = screen.getAllByRole('button', { name: 'パスワードを表示' })
    expect(toggles).toHaveLength(2)

    await user.click(toggles[0])
    expect(password).toHaveAttribute('type', 'text')
    // 片方を開いても、もう片方は隠れたまま。
    expect(confirm).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: 'パスワードを隠す' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('redirects a deep link to a later step back to the beginning', async () => {
    renderApp('/signup/confirm')
    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup')
  })
})

// Google auth has no separate sign-up/sign-in intent (AuthProvider.loginWithGoogle
// is the same function LoginPage.tsx calls) - these two tests exercise the
// "Googleでサインイン" button added to the registration screen's step 1
// alongside the existing e-mail/password form, covering both outcomes
// resolveLoginState can return.
describe('Googleでサインイン from /signup', () => {
  it('routes a brand-new Google identity to /signup/additional-info', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({
      user: {
        uid: 'google-uid-1',
        email: 'hanako@example.com',
        getIdToken: vi.fn().mockResolvedValue('google-id-token'),
      },
    } as unknown as Awaited<ReturnType<typeof signInWithPopup>>)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/session/csrf')) return jsonResponse({ csrfToken: 'csrf-token' })
      if (url.includes('/api/session/login')) return jsonResponse({ status: 'additional_info_required' })
      if (url.includes('/api/session/me')) {
        return jsonResponse({ error: { code: 'unauthenticated', message: 'no session' } }, 401)
      }
      throw new Error(`Unhandled fetch in test: ${url}`)
    })

    const user = userEvent.setup()
    renderApp('/signup')

    await user.click(await screen.findByRole('button', { name: 'Googleでサインイン' }))

    expect(await screen.findByRole('heading', { name: '追加情報の入力' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup/additional-info')
  })

  it('signs an existing Google account straight in, bypassing the wizard', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({
      user: {
        uid: 'google-uid-2',
        email: 'hanako2@example.com',
        getIdToken: vi.fn().mockResolvedValue('google-id-token-2'),
      },
    } as unknown as Awaited<ReturnType<typeof signInWithPopup>>)
    // beforeEach's default fetch mock already resolves /api/session/login to
    // {status:'ok'} and /api/session/me to an authenticated user once that
    // happens - the "existing account" path needs no extra fetch overrides.

    const user = userEvent.setup()
    renderApp('/signup')

    await user.click(await screen.findByRole('button', { name: 'Googleでサインイン' }))

    // useSignupGate('account') redirects an already-authenticated visitor
    // away from the wizard, same as <RequireGuest> does for LoginPage.tsx.
    await waitFor(() => expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument())
    expect(window.location.pathname).toBe('/')
  })
})

describe('step 1 アカウント作成 validation', () => {
  it('shows field-level errors for bad email, short password, mismatch and missing consent', async () => {
    const user = userEvent.setup()
    renderApp('/signup')

    await user.type(await screen.findByLabelText('名前（漢字）'), '山田 太郎')
    await user.type(screen.getByLabelText('名前（カナ）'), 'ヤマダ タロウ')
    await user.type(screen.getByLabelText('メールアドレス'), 'not-an-email')
    await user.type(screen.getByLabelText('パスワード'), 'short')
    await user.type(screen.getByLabelText('パスワード確認'), 'different')
    await user.click(screen.getByRole('button', { name: '新規登録' }))

    expect(await screen.findByText('メールアドレスの形式で入力してください。')).toBeInTheDocument()
    expect(screen.getByText('パスワードは8文字以上で入力してください。')).toBeInTheDocument()
    expect(screen.getByText('利用規約への同意が必要です。')).toBeInTheDocument()
    // Still on step 1 - nothing was submitted.
    expect(window.location.pathname).toBe('/signup')
  })

  it('rejects an e-mail outside the spec 3.4 domains before any backend call', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    renderApp('/signup')

    await user.type(await screen.findByLabelText('名前（漢字）'), '山田 太郎')
    await user.type(screen.getByLabelText('名前（カナ）'), 'ヤマダ タロウ')
    await user.type(screen.getByLabelText('メールアドレス'), 'taro@gmail.com')
    await user.type(screen.getByLabelText('パスワード'), 'password123')
    await user.type(screen.getByLabelText('パスワード確認'), 'password123')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: '新規登録' }))

    // The backend answers a disallowed domain with a bare `invalid-argument`
    // ("Invalid registration information."), which reaches the 確認 screen as
    // an unattributed 400 - catch it on the screen that owns the field.
    expect(
      await screen.findByText('メールアドレスは @example.com / @example.net / @example.org のみ利用できます。'),
    ).toBeInTheDocument()
    expect(registerWithEmailPassword).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/signup')
  })

  // Spec 4.1: the backend now checks for a duplicate account at step 1
  // (`startEmailVerification`), before any OTP is issued, instead of only at
  // the final confirm screen (`registerWithEmailPassword`).
  it('surfaces the conflict message at step 1 when the address is already ' +
    'registered, without reaching /signup/verify', async () => {
    const startEmailVerification = vi
      .fn()
      .mockRejectedValue(new FirebaseError('functions/already-exists', 'The account is being deleted.'))
    mockCallables({ startEmailVerification })
    const user = userEvent.setup()
    renderApp('/signup')

    await fillAccountStep(user)

    expect(
      await screen.findByText('このメールアドレスはすでに登録されています。ログイン画面からお進みください。'),
    ).toBeInTheDocument()
    expect(startEmailVerification).toHaveBeenCalledWith({ email: 'taro@example.com' })
    // Stays on step 1 - the verify screen must never be reached.
    expect(window.location.pathname).toBe('/signup')
    expect(screen.queryByRole('heading', { name: 'メールアドレスを確認してください' })).not.toBeInTheDocument()
  })
})

describe('step 2 メール認証', () => {
  it('asks the backend for a code on step 1, rejects a wrong one, and passes the issued one', async () => {
    const handlers = mockCallables()
    const user = userEvent.setup()
    renderApp('/signup')
    await fillAccountStep(user)

    expect(await screen.findByRole('heading', { name: 'メールアドレスを確認してください' })).toBeInTheDocument()
    expect(screen.getByText('taro@example.com')).toBeInTheDocument()
    // Submitting step 1 is what asks the backend to issue the code.
    await waitFor(() =>
      expect(handlers.startEmailVerification).toHaveBeenCalledWith({ email: 'taro@example.com' }),
    )

    const codeInput = screen.getByLabelText('認証コード')
    await user.type(codeInput, '000000')
    await user.click(screen.getByRole('button', { name: '認証する' }))
    expect(await screen.findByText('認証コードが正しくありません。')).toBeInTheDocument()

    await user.clear(codeInput)
    await user.type(codeInput, ISSUED_CODE)
    await user.click(screen.getByRole('button', { name: '認証する' }))

    expect(await screen.findByRole('heading', { name: '契約者情報の入力' })).toBeInTheDocument()
    expect(handlers.verifyEmailCode).toHaveBeenLastCalledWith({
      email: 'taro@example.com',
      code: ISSUED_CODE,
    })
  })

  // Displaying the code would hand it to anyone looking at the screen; the
  // visitor gets it through a separate retrieval path instead.
  it('never renders the issued code on the screen', async () => {
    const user = userEvent.setup()
    renderApp('/signup')
    await fillAccountStep(user)

    await screen.findByRole('heading', { name: 'メールアドレスを確認してください' })
    expect(screen.queryByText(ISSUED_CODE)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(ISSUED_CODE)
  })

  // The wording of a failed resend is asserted in api/signupApi.test.ts -
  // it lands in a sonner toast, which only mounts when window.matchMedia
  // exists (AppLayout.tsx). Here we only pin that the button calls it.
  it('asks the backend for a new code from 認証コードを再送する', async () => {
    const handlers = mockCallables()
    const user = userEvent.setup()
    renderApp('/signup')
    await fillAccountStep(user)

    await user.click(await screen.findByRole('button', { name: '認証コードを再送する' }))

    await waitFor(() =>
      expect(handlers.resendEmailVerificationCode).toHaveBeenCalledWith({ email: 'taro@example.com' }),
    )
  })

  it('keeps the entered account details when going back via メールアドレスを変更する', async () => {
    const user = userEvent.setup()
    renderApp('/signup')
    await fillAccountStep(user)

    await user.click(await screen.findByRole('button', { name: 'メールアドレスを変更する' }))

    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeInTheDocument()
    expect(screen.getByLabelText('名前（漢字）')).toHaveValue('山田 太郎')
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('taro@example.com')
  })
})

describe('step 3 契約者情報 validation', () => {
  it('requires 会社名/担当者名 for 法人', async () => {
    const user = userEvent.setup()
    await walkToContract(user)

    await user.click(screen.getByRole('radio', { name: '法人' }))
    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByText('会社名を入力してください。')).toBeInTheDocument()
    expect(screen.getByText('担当者名を入力してください。')).toBeInTheDocument()
  })

  it('requires 屋号/担当者名 (relabeled) for 個人事業主', async () => {
    const user = userEvent.setup()
    await walkToContract(user)

    await user.click(screen.getByRole('radio', { name: '個人事業主' }))
    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByText('屋号を入力してください。')).toBeInTheDocument()
    expect(screen.getByText('担当者名を入力してください。')).toBeInTheDocument()
  })

  it('keeps the contract input when returning from the confirm screen (戻って修正する)', async () => {
    const user = userEvent.setup()
    await walkToContract(user)

    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))
    await screen.findByRole('heading', { name: '入力内容の確認' })

    await user.click(screen.getByRole('button', { name: '戻って修正する' }))

    expect(await screen.findByRole('heading', { name: '契約者情報の入力' })).toBeInTheDocument()
    expect(screen.getByLabelText('電話番号')).toHaveValue('090-1234-5678')
    expect(screen.getByLabelText('生年月日')).toHaveValue('1990-01-01')
    expect(screen.getByLabelText('都道府県')).toHaveValue('東京都')
    expect(screen.getByLabelText('番地')).toHaveValue('千代田1-1-1')
  })
})

describe('step 3 契約者情報 → step 4 確認 → 完了', () => {
  it('completes the whole individual flow, registers via Firebase, and lands on the dashboard signed in', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    await walkToContract(user)

    // 氏名/カナ arrive pre-filled from step 1.
    expect(screen.getByLabelText('名前（漢字）')).toHaveValue('山田 太郎')
    expect(screen.getByLabelText('名前（カナ）')).toHaveValue('ヤマダ タロウ')

    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByRole('heading', { name: '入力内容の確認' })).toBeInTheDocument()
    expect(screen.getAllByText('個人').length).toBeGreaterThan(0)
    expect(screen.getByText('山田 太郎')).toBeInTheDocument()
    expect(screen.getByText('taro@example.com')).toBeInTheDocument()
    expect(screen.getByText('090-1234-5678')).toBeInTheDocument()
    expect(screen.getByText('1990-01-01')).toBeInTheDocument()
    expect(screen.getByText('〒100-0001')).toBeInTheDocument()
    expect(screen.getByText('東京都千代田区千代田1-1-1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(registerWithEmailPassword).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'taro@example.com', password: 'password123', accountType: 'individual' }),
    )
    // completeSignup() must never leak the plaintext password anywhere beyond
    // the Callable payload itself (e.g. into sessionStorage's signup draft).
    // Issue #85's fix clears the draft entirely right after markCompleted(),
    // so by the time completeSignup() resolves above the key is already gone
    // (asserted below) - `?? ''` keeps this assertion meaningful either way.
    expect(window.sessionStorage.getItem('registrar.signup.draft.v2') ?? '').not.toContain('password123')

    expect(await screen.findByRole('heading', { name: '登録が完了しました' })).toBeInTheDocument()
    // Issue #85: the PII draft mirror must be gone entirely once registration
    // completes, not merely scrubbed of the password. /signup/complete still
    // rendering above confirms state.completed stayed true (clearSignupDraft(),
    // not reset(), was used).
    expect(window.sessionStorage.getItem('registrar.signup.draft.v2')).toBeNull()
    await user.click(screen.getByRole('link', { name: 'マイページへ' }))

    // The confirm step established the Cookie session (recheckSession), so
    // the guard lets us through.
    expect(await screen.findByRole('heading', { name: 'マイページ' })).toBeInTheDocument()
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('completes a 個人事業主 registration end-to-end with the 屋号 label and business fields submitted', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    await walkToContract(user)

    await user.click(screen.getByRole('radio', { name: '個人事業主' }))
    await fillContactSection(user)
    await user.type(screen.getByLabelText('屋号'), '山田商店')
    await user.type(screen.getByLabelText('担当者名'), '山田 太郎')
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByRole('heading', { name: '入力内容の確認' })).toBeInTheDocument()
    expect(screen.getByText('会社情報')).toBeInTheDocument()
    expect(screen.getByText('山田商店')).toBeInTheDocument()
    expect(screen.getAllByText('個人事業主').length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(registerWithEmailPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        accountType: 'sole-proprietor',
        business: expect.objectContaining({ companyName: '山田商店', contactPerson: '山田 太郎' }),
      }),
    )

    expect(await screen.findByRole('heading', { name: '登録が完了しました' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'マイページへ' }))
    expect(await screen.findByRole('heading', { name: 'マイページ' })).toBeInTheDocument()
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('completes an international (non-Japan) address registration end-to-end', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    await walkToContract(user)

    await fillInternationalContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByRole('heading', { name: '入力内容の確認' })).toBeInTheDocument()
    expect(screen.getByText('アメリカ合衆国')).toBeInTheDocument()
    expect(screen.getByText('〒94105')).toBeInTheDocument()
    expect(screen.getByText('123 Main St, Apt 4B, San Francisco, California')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(registerWithEmailPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining({
          country: 'US',
          postalCode: '94105',
          state: 'California',
          city: 'San Francisco',
          addressLine1: '123 Main St',
          addressLine2: 'Apt 4B',
        }),
      }),
    )

    expect(await screen.findByRole('heading', { name: '登録が完了しました' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'マイページへ' }))
    expect(await screen.findByRole('heading', { name: 'マイページ' })).toBeInTheDocument()
  })

  it.each([
    ['男性', 'male'],
    ['その他', 'other'],
  ] as const)('completes registration with 性別 = %s selected via the select', async (label, value) => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    await walkToContract(user)

    await user.selectOptions(screen.getByLabelText('性別'), label)
    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByRole('heading', { name: '入力内容の確認' })).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(registerWithEmailPassword).toHaveBeenCalledWith(expect.objectContaining({ gender: value }))
  })

  it('completes registration with お知らせメールを受け取る checked (newsletterOptIn: true)', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    const user = userEvent.setup()
    await walkToContract(user)

    await user.click(screen.getByRole('checkbox', { name: 'お知らせメールを受け取る' }))
    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))

    expect(await screen.findByRole('heading', { name: '入力内容の確認' })).toBeInTheDocument()
    expect(screen.getByText('受け取る')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(registerWithEmailPassword).toHaveBeenCalledWith(expect.objectContaining({ newsletterOptIn: true }))
  })

  // The backend re-checks the verification grant, so a lapsed one is
  // refused at 確認 even though the wizard let the visitor get that far.
  it('explains a lapsed e-mail verification instead of a generic failure', async () => {
    const registerWithEmailPassword = vi
      .fn()
      .mockRejectedValue(
        new FirebaseError('functions/failed-precondition', 'The e-mail address has not been verified.'),
      )
    mockCallables({ registerWithEmailPassword })

    const user = userEvent.setup()
    await walkToContract(user)
    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))
    await screen.findByRole('heading', { name: '入力内容の確認' })

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    expect(
      await screen.findByText(
        'メールアドレスの認証が完了していないか、有効期限が切れています。お手数ですが認証をやり直してください。',
      ),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup/confirm')
  })

  it('surfaces a mapped error and stays on the confirm screen when registration conflicts (already-exists)', async () => {
    const registerWithEmailPassword = mockConflictingRegistration()
    const user = userEvent.setup()
    await walkToContract(user, 'demo@example.com')

    await fillContactSection(user)
    await user.click(screen.getByRole('button', { name: '確認画面へ' }))
    await screen.findByRole('heading', { name: '入力内容の確認' })

    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(registerWithEmailPassword).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByText('登録を完了できませんでした。時間をおいて再度お試しください。'),
    ).toBeInTheDocument()
    // Not signed in, and still on the confirm screen - no session was ever established.
    expect(window.location.pathname).toBe('/signup/confirm')
    expect(signInWithEmailAndPassword).not.toHaveBeenCalled()
  })
})

describe('reload past the in-memory password', () => {
  // SignupProvider deliberately keeps `password` out of the sessionStorage
  // draft while every prerequisite flag survives, so a mid-wizard reload used
  // to reach 確認 with a blank password and register it - the backend then
  // rejected the call with `invalid-argument` ("Invalid registration
  // information."). useSignupGate must re-ask at step 1 instead.
  function seedPasswordlessDraft() {
    window.sessionStorage.setItem(
      'registrar.signup.draft.v2',
      JSON.stringify({
        started: true,
        emailVerified: true,
        contractFilled: true,
        completed: false,
        data: { email: 'taro@example.com', name: '山田 太郎', nameKana: 'ヤマダ タロウ' },
      }),
    )
  }

  it('sends a reloaded 確認 screen back to step 1 with the reason, without registering', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()
    seedPasswordlessDraft()

    renderApp('/signup/confirm')

    await screen.findByRole('heading', { name: '新規登録' })
    expect(window.location.pathname).toBe('/signup')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'セキュリティのためパスワードは保持されません。お手数ですが最初からやり直してください。',
    )
    expect(registerWithEmailPassword).not.toHaveBeenCalled()
  })

  it('sends a reloaded 契約者情報 screen back to step 1 as well', async () => {
    seedPasswordlessDraft()

    renderApp('/signup/contract')

    await screen.findByRole('heading', { name: '新規登録' })
    expect(window.location.pathname).toBe('/signup')
  })

  it('rejects a blank password in completeSignup before any Callable runs', async () => {
    const registerWithEmailPassword = mockSuccessfulRegistration()

    await expect(
      completeSignup({ ...EMPTY_REGISTRATION_DATA, email: 'taro@example.com', password: '' }),
    ).rejects.toThrow('セキュリティのためパスワードは保持されません。お手数ですが最初からやり直してください。')
    expect(registerWithEmailPassword).not.toHaveBeenCalled()
  })
})
