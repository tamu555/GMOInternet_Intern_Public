/**
 * Integration tests for the auth flows of docs/api-flow-diagrams.html.
 *
 * Rewritten for the full-profile-registration feature: `authApi.ts`'s
 * `login`/`fetchMe` now drive the real Firebase Auth SDK + the Cookie session
 * (`sessionApi.ts`), not MSW-mocked REST - so this file mocks
 * `firebase/auth` at the module level and spies on `global.fetch` for the
 * `/api/session/*` calls, falling back to the real (MSW-patched) fetch for
 * every other path so the still-MSW-backed `domainsApi` call in the FIG.8
 * lower-half test keeps working unchanged.
 *
 * FIG.5 (registration via the old /register page) is removed: RegisterPage
 * is retired in favor of the /signup wizard (see signupFlow.test.tsx) - this
 * file only keeps a redirect check for the old path.
 */
import { StrictMode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { FirebaseError } from 'firebase/app'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { AuthProvider } from '../auth/AuthProvider'
import { useAuth } from '../auth/useAuth'
import { clearAccessToken, readAccessToken } from '../auth/tokenStorage'
import { resetUsers } from '../mocks/db'
import { resetScenario, setScenario } from '../mocks/scenario'
import { server } from '../mocks/server'
import { AppRouter } from './AppRouter'

/* ログインのメール欄は＠のうしろのプルダウンを廃止して1つの入力欄に
   なったので、アドレス全体を打つ。 */
const DEMO_EMAIL = 'demo@example.com'
const DEMO_PASSWORD = 'password123'
const DEMO_USER = { id: '1', email: 'demo@example.com', displayName: 'Taro Test' }

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

/** StrictMode double-renders; anything resolved during render must survive it. */
function renderAppStrict(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(
    <StrictMode>
      <AppRouter />
    </StrictMode>,
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function submitLoginForm(user: ReturnType<typeof userEvent.setup>, password = DEMO_PASSWORD) {
  await user.type(await screen.findByLabelText('メールアドレス'), DEMO_EMAIL)
  await user.type(screen.getByLabelText('パスワード'), password)
  await user.click(screen.getByRole('button', { name: 'ログイン' }))
}

function mockSuccessfulSignIn() {
  vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
    user: { getIdToken: vi.fn().mockResolvedValue('id-token') },
  } as unknown as Awaited<ReturnType<typeof signInWithEmailAndPassword>>)
}

let sessionEstablished = false
let sessionMeStatus: number | 'server-error' = 401
let originalFetch: typeof globalThis.fetch

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
  originalFetch = globalThis.fetch
})
afterAll(() => server.close())

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearAccessToken()
  resetUsers()
  resetScenario()
  setScenario({ latencyMs: 0 })

  sessionEstablished = false
  sessionMeStatus = 401
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/session/csrf')) return jsonResponse({ csrfToken: 'csrf-token' })
    if (url.includes('/api/session/login')) {
      sessionEstablished = true
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/logout')) {
      sessionEstablished = false
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/me')) {
      if (sessionMeStatus === 'server-error') {
        return jsonResponse({ error: { code: 'internal', message: 'boom' } }, 500)
      }
      if (!sessionEstablished) {
        return jsonResponse({ error: { code: 'unauthenticated', message: 'no session' } }, 401)
      }
      return jsonResponse({ id: DEMO_USER.id, email: DEMO_USER.email, displayName: DEMO_USER.displayName })
    }
    // Everything else (domainsApi/ordersApi/mypageApi, still MSW-backed) goes
    // through the real fetch, which MSW's node interceptor patches.
    return originalFetch(input, init)
  })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.restoreAllMocks()
})

describe('FIG.7 session restore on reload (Cookie-first)', () => {
  it('shows the checking state first and never flashes the login screen for a valid session', async () => {
    let resolveSessionMe!: () => void
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!url.includes('/api/session/me')) throw new Error(`Unhandled fetch in test: ${url}`)
      return new Promise((resolve) => {
        resolveSessionMe = () =>
          resolve(jsonResponse({ id: DEMO_USER.id, email: DEMO_USER.email, displayName: DEMO_USER.displayName }))
      })
    })

    renderApp('/dashboard')

    // The very first frame must be "確認中" - not the login screen.
    expect(screen.getByText('ログイン状態を確認しています…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'ログイン' })).not.toBeInTheDocument()

    resolveSessionMe()
    expect(await screen.findByRole('heading', { name: '認証の動作確認' })).toBeInTheDocument()
  })

  it('settles on unauthenticated when there is no valid Cookie session (401)', async () => {
    renderApp('/dashboard')

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
  })

  it('offers a retry when the check fails for a non-401 reason, without logging the user out', async () => {
    sessionMeStatus = 'server-error'

    renderApp('/dashboard')

    // A 5xx does not prove the session is dead, but the three-state model
    // still has no "authenticated" answer to give - RequireAuth sends the
    // user to /login (same as any unauthenticated visit), where the retry
    // banner - not a generic error - is what distinguishes this from a
    // plain logged-out visit.
    expect(await screen.findByRole('button', { name: '再確認する' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
  })
})

describe('FIG.8 protected route redirect', () => {
  it('records returnTo and comes back to it after a successful login', async () => {
    mockSuccessfulSignIn()
    const user = userEvent.setup()

    // かんたんモードは目的/名前/末尾の3ステップが公開ルートになり、保護は
    // 契約内容の確認から。returnTo の対象もそこに合わせる（ログイン後、まだ
    // 入力が無いので useEasyGate が /easy/goal へ差し戻すところまで見る）。
    renderApp('/easy/confirm')

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBe('/easy/confirm')

    await submitLoginForm(user)

    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')
  })

  it('honours a returnTo that only survives in storage, under StrictMode', async () => {
    mockSuccessfulSignIn()
    const user = userEvent.setup()
    // Reproduces "bounced to /login, then reloaded the login screen": the router
    // state is gone and sessionStorage is the only remaining source.
    window.sessionStorage.setItem('registrar.auth.returnTo', '/dashboard')

    renderAppStrict('/login')
    await submitLoginForm(user)

    expect(await screen.findByRole('heading', { name: '認証の動作確認' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
  })

  it('lands on the search top page when there was no returnTo (updated FIG.6)', async () => {
    mockSuccessfulSignIn()
    const user = userEvent.setup()

    renderApp('/login')
    await submitLoginForm(user)

    // Deliberate login (no bounce) now returns to '/': the public search page,
    // rendered in the logged-in state. DomainSearchPage renders two
    // <h1>ドメイン検索</h1> elements (outer header + hero-band eyebrow) - a
    // pre-existing quirk unrelated to this feature, hence findAllByRole.
    expect((await screen.findAllByRole('heading', { name: 'ドメイン検索' })).length).toBeGreaterThan(0)
    expect(window.location.pathname).toBe('/')
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('detects a 401 raised by an ordinary API call and returns to login with returnTo', async () => {
    sessionEstablished = true // already-authenticated Cookie session on mount
    renderApp('/dashboard')
    await screen.findByRole('heading', { name: '認証の動作確認' })

    // Force the next protected REST call (domainsApi, still MSW-backed and
    // orthogonal to the Cookie session) to answer 401, the same shape a
    // revoked/expired session would produce - this exercises httpClient.ts's
    // common 401 handling without depending on how the mock backend encodes
    // the sentinel bearer token.
    const { http, HttpResponse } = await import('msw')
    server.use(http.get('/api/domains', () => HttpResponse.json({ message: 'unauthorized' }, { status: 401 })))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '保護APIを呼ぶ（GET /api/domains）' }))

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBe('/dashboard')
  })
})

describe('FIG.6 login', () => {
  it('signs the user in via Firebase and establishes the Cookie session', async () => {
    mockSuccessfulSignIn()
    const user = userEvent.setup()

    renderApp('/login')
    await submitLoginForm(user)

    await waitFor(() =>
      expect(signInWithEmailAndPassword).toHaveBeenCalledWith(expect.anything(), 'demo@example.com', DEMO_PASSWORD),
    )
    expect((await screen.findAllByRole('heading', { name: 'ドメイン検索' })).length).toBeGreaterThan(0)
    // The sentinel is written for httpClient.ts's unrelated bearer-header
    // compatibility (architecture doc §1.4(c)) - never a real credential.
    expect(readAccessToken()).toBe('firebase-session')
  })

  it('shows one message that does not say which field was wrong (auth/wrong-password)', async () => {
    vi.mocked(signInWithEmailAndPassword).mockRejectedValue(
      new FirebaseError('auth/wrong-password', 'The password is invalid.'),
    )
    const user = userEvent.setup()

    renderApp('/login')
    await submitLoginForm(user, 'wrong-password')

    expect(await screen.findByText('メールアドレスまたはパスワードが違います。')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
  })

  it('shows the retry-later message on an unmapped Firebase Auth error', async () => {
    vi.mocked(signInWithEmailAndPassword).mockRejectedValue(new FirebaseError('auth/internal-error', 'boom'))
    const user = userEvent.setup()

    renderApp('/login')
    await submitLoginForm(user)

    expect(await screen.findByText('時間をおいて再度お試しください。')).toBeInTheDocument()
  })

  it('blocks submission and reports the field when the form is empty', async () => {
    const user = userEvent.setup()

    renderApp('/login')
    await user.click(await screen.findByRole('button', { name: 'ログイン' }))

    expect(await screen.findByText('メールアドレスを入力してください。')).toBeInTheDocument()
    expect(screen.getByText('パスワードを入力してください。')).toBeInTheDocument()
    expect(signInWithEmailAndPassword).not.toHaveBeenCalled()
  })
})

describe('header logout confirmation', () => {
  /* `header.getByRole('button', { name: 'ログアウト' })` mirrors
     `assistantFlow.test.tsx`'s own `appHeader()` helper - the same query
     doubles as the confirm dialog's own confirm button once it is open, so
     the header is scoped explicitly rather than relying on it being the
     only match. */
  function header(): HTMLElement {
    const el = document.querySelector('header.sticky')
    if (!el) throw new Error('AppLayout header not found')
    return el as HTMLElement
  }

  async function loginAndOpenLogoutDialog(user: ReturnType<typeof userEvent.setup>) {
    mockSuccessfulSignIn()
    renderApp('/login')
    await submitLoginForm(user)
    expect(await screen.findByText('AuthContext: 認証済み')).toBeInTheDocument()

    await user.click(within(header()).getByRole('button', { name: 'ログアウト' }))
    return screen.findByRole('dialog')
  }

  it('opens a confirmation dialog instead of logging out immediately', async () => {
    const user = userEvent.setup()

    await loginAndOpenLogoutDialog(user)

    expect(screen.getByText('ログアウトしますか？')).toBeInTheDocument()
    // Clicking the trigger must not have logged the user out by itself.
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('キャンセル closes the dialog without logging out', async () => {
    const user = userEvent.setup()
    const dialog = await loginAndOpenLogoutDialog(user)

    await user.click(within(dialog).getByRole('button', { name: 'キャンセル' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('Escape closes the dialog without logging out', async () => {
    const user = userEvent.setup()
    await loginAndOpenLogoutDialog(user)

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('confirming ログアウト in the dialog logs the user out', async () => {
    const user = userEvent.setup()
    const dialog = await loginAndOpenLogoutDialog(user)

    await user.click(within(dialog).getByRole('button', { name: 'ログアウト' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('AuthContext: 未認証')).toBeInTheDocument()
  })
})

/**
 * issue #84: `returnTo` (FIG.8) is not scoped to the session that recorded it.
 * Logging out from a protected page used to leave `RequireAuth` mounted long
 * enough to re-capture that very URL (both to sessionStorage and to the
 * `/login` navigation's router state) before the redirect completed, so
 * whichever account logged in next got auto-navigated straight back to it -
 * landing a freshly-authenticated session on a page/resource it may not own
 * (the backend's ownership check then correctly rejects it with a 403). See
 * `.agents/docs/research/issue-84-relogin-403.md`. AuthProvider.logout() now
 * clears `returnTo` and navigates to /login itself before flipping the auth
 * state, so an intentional logout never re-arms it.
 */
describe('issue #84: an intentional logout must not leak returnTo to the next login', () => {
  function header(): HTMLElement {
    const el = document.querySelector('header.sticky')
    if (!el) throw new Error('AppLayout header not found')
    return el as HTMLElement
  }

  async function logoutViaHeader(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(header()).getByRole('button', { name: 'ログアウト' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'ログアウト' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  }

  it('clears the recorded returnTo and lands on /login when logging out from a protected route', async () => {
    sessionEstablished = true // already-authenticated Cookie session on mount
    renderApp('/dashboard')
    await screen.findByRole('heading', { name: '認証の動作確認' })

    const user = userEvent.setup()
    await logoutViaHeader(user)

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    // The pre-fix bug: RequireAuth's unauthenticated branch, still mounted on
    // /dashboard for one render, re-saved this exact path here.
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBeNull()
  })

  it('sends the next login to the default authenticated path, not back to the page the logged-out session was viewing', async () => {
    mockSuccessfulSignIn()
    sessionEstablished = true // "user A" already authenticated on mount
    renderApp('/dashboard')
    await screen.findByRole('heading', { name: '認証の動作確認' })

    const user = userEvent.setup()
    await logoutViaHeader(user)
    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()

    // "user B" (a different account in the real world) signs in next, in the
    // same tab. This test harness models only one credential set end-to-end,
    // so it asserts the frontend-level guarantee that matters here: the SPA
    // must not auto-navigate the newly-authenticated session to whatever URL
    // the previous, now-logged-out session happened to be on. (The backend's
    // per-account ownership check - out of scope for this frontend test - is
    // exercised separately; see functions/src/domain/ownership.test.ts.)
    await submitLoginForm(user)

    expect((await screen.findAllByRole('heading', { name: 'ドメイン検索' })).length).toBeGreaterThan(0)
    expect(window.location.pathname).toBe('/')
  })
})

describe('/register retirement', () => {
  it('redirects /register to /signup instead of rendering the retired page', async () => {
    renderApp('/register')

    expect(await screen.findByRole('heading', { name: '新規登録' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup')
  })
})

describe('AuthProvider: session cleared by another tab', () => {
  function AuthProbe() {
    const { state, recheckSession } = useAuth()
    return (
      <div>
        <span>state:{state.status}</span>
        <button type="button" onClick={() => void recheckSession()}>
          recheck
        </button>
      </div>
    )
  }

  it('a recheckSession() after another tab logs out observes unauthenticated, not stale authenticated state', async () => {
    sessionEstablished = true // this tab mounts already authenticated
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('state:authenticated')).toBeInTheDocument()

    // Simulates another tab calling sessionLogout(): the shared mock models
    // the one real Cookie both tabs read, so /api/session/me now 401s.
    sessionEstablished = false

    await user.click(screen.getByRole('button', { name: 'recheck' }))

    expect(await screen.findByText('state:unauthenticated')).toBeInTheDocument()
  })
})
