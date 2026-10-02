/**
 * Integration tests for the Google post-signin "additional info" screen
 * (architecture doc §1.1-§1.3, /signup/additional-info): a Google user who
 * signed in but has no full profile yet (`pending_additional_info`) fills the
 * same profile fields the /signup wizard's step 3 (契約者情報) collects,
 * submits via the `submitAdditionalInfo` Callable, then a second
 * `sessionLogin` round-trip actually establishes the Cookie session.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

// Post-registration success lands on DomainSearchPage
// (DEFAULT_AUTHENTICATED_PATH), which now speaks Firebase callables
// (api/callable.ts) for its TLD list / search - route those through the
// fakeBackend seam instead of the raw `httpsCallable` mock above, which is
// reserved for this screen's own direct `submitAdditionalInfo` call and
// would otherwise resolve every unrelated callable to the same mock fn.
vi.mock('../../api/callable', async () => {
  const { fakeInvoke } = await import('../../test/fakeBackend')
  return { invoke: fakeInvoke }
})

import { httpsCallable } from 'firebase/functions'
import { AppRouter } from '../../app/AppRouter'
import { auth } from '../../firebase/client'
import { readAdditionalInfoPending, saveAdditionalInfoPending } from '../../auth/additionalInfoState'
import { clearAccessToken } from '../../auth/tokenStorage'
import { fakeBackend } from '../../test/fakeBackend'

const GOOGLE_USER = { uid: 'google-uid-1', email: 'taro@example.com' }

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockCallable(result: unknown) {
  const fn = vi.fn().mockResolvedValue({ data: result })
  ;(httpsCallable as unknown as Mock).mockReturnValue(fn)
  return fn
}

async function fillProfileForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('名前（漢字）'), '山田 太郎')
  await user.type(screen.getByLabelText('名前（カナ）'), 'ヤマダ タロウ')
  await user.type(screen.getByLabelText('電話番号'), '090-1234-5678')
  await user.type(screen.getByLabelText('生年月日'), '1990-01-01')
  await user.type(screen.getByLabelText('郵便番号'), '100-0001')
  await user.selectOptions(screen.getByLabelText('都道府県'), '東京都')
  await user.type(screen.getByLabelText('市区町村'), '千代田区')
  await user.type(screen.getByLabelText('番地'), '千代田1-1-1')
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearAccessToken()
  fakeBackend.reset()
  // No Cookie session exists until this screen's own sessionLogin call
  // succeeds - the mock tracks that transition instead of pretending every
  // test starts already authenticated (which would make <RequireGuest>-style
  // guards redirect the page away before the form is even reachable).
  let sessionEstablished = false
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/session/csrf')) return jsonResponse({ csrfToken: 'csrf-token' })
    if (url.includes('/api/session/login')) {
      sessionEstablished = true
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/me')) {
      if (!sessionEstablished) {
        return jsonResponse({ error: { code: 'unauthenticated', message: 'no session' } }, 401)
      }
      return jsonResponse({ id: GOOGLE_USER.uid, email: GOOGLE_USER.email, displayName: '山田 太郎' })
    }
    throw new Error(`Unhandled fetch in test: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('/signup/additional-info', () => {
  it('redirects to /login when there is no pending Google sign-in marker and no current user', async () => {
    renderApp('/signup/additional-info')

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(screen.queryByLabelText('名前（漢字）')).not.toBeInTheDocument()
  })

  it('renders the full profile form and completes the additional-info flow', async () => {
    saveAdditionalInfoPending(GOOGLE_USER)
    vi.spyOn(auth, 'currentUser', 'get').mockReturnValue({
      uid: GOOGLE_USER.uid,
      email: GOOGLE_USER.email,
      getIdToken: vi.fn().mockResolvedValue('id-token'),
    } as unknown as typeof auth.currentUser)
    const submitAdditionalInfo = mockCallable({ status: 'active' })

    const user = userEvent.setup()
    renderApp('/signup/additional-info')

    expect(await screen.findByRole('heading', { name: '追加情報の入力' })).toBeInTheDocument()
    await fillProfileForm(user)
    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    await waitFor(() => expect(submitAdditionalInfo).toHaveBeenCalledTimes(1))

    // The pending marker is cleared once the second sessionLogin succeeds.
    await waitFor(() => expect(readAdditionalInfoPending()).toBeNull())

    // DomainSearchPage (the DEFAULT_AUTHENTICATED_PATH landing target) renders
    // two <h1>ドメイン検索</h1> elements (an outer header plus a hero-band
    // eyebrow) - a pre-existing quirk unrelated to this feature, hence
    // findAllByRole rather than findByRole here.
    expect(await screen.findAllByRole('heading', { name: 'ドメイン検索' })).not.toHaveLength(0)
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('requires 屋号/担当者名 for 個人事業主 and keeps the marker until submission succeeds', async () => {
    saveAdditionalInfoPending(GOOGLE_USER)
    vi.spyOn(auth, 'currentUser', 'get').mockReturnValue({
      uid: GOOGLE_USER.uid,
      email: GOOGLE_USER.email,
      getIdToken: vi.fn().mockResolvedValue('id-token'),
    } as unknown as typeof auth.currentUser)
    const submitAdditionalInfo = mockCallable({ status: 'active' })

    const user = userEvent.setup()
    renderApp('/signup/additional-info')

    await screen.findByRole('heading', { name: '追加情報の入力' })
    await user.click(screen.getByRole('radio', { name: '個人事業主' }))
    await fillProfileForm(user)
    await user.click(screen.getByRole('button', { name: 'この内容で登録する' }))

    expect(await screen.findByText('屋号を入力してください。')).toBeInTheDocument()
    expect(screen.getByText('担当者名を入力してください。')).toBeInTheDocument()
    expect(submitAdditionalInfo).not.toHaveBeenCalled()
    expect(readAdditionalInfoPending()).toEqual(GOOGLE_USER)
  })
})
