/**
 * Regression guard for the §1.4(c) sentinel-token compatibility shim: even
 * though the Cookie session is now the sole auth authority, a successful
 * login() must still write a non-null token to tokenStorage.ts, because
 * httpClient.ts (the out-of-scope domains/orders/mypage modules) reads it
 * verbatim as the Authorization header.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionMe } from '../api/sessionApi'
import { appendMessage, ensureActiveConversation, getChatSnapshot, resetChatStoreForTest } from '../features/assistant/store/chatStore'
import { AuthProvider } from './AuthProvider'
import { clearAccessToken, readAccessToken } from './tokenStorage'
import { useAuth } from './useAuth'

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null, signOut: vi.fn() })),
  connectAuthEmulator: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: class {},
}))

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  connectFunctionsEmulator: vi.fn(),
}))

vi.mock('../api/sessionApi', () => ({
  issueCsrfToken: vi.fn(async () => ({ csrfToken: 'csrf-token' })),
  sessionLogin: vi.fn(async () => ({ status: 'ok' })),
  sessionLogout: vi.fn(async () => undefined),
  sessionMe: vi.fn(),
}))

// The mocked sessionMe below throws a plain object, not the real ApiError
// class (importing api/apiError.ts here would defeat the point of asserting
// against the module boundary) - AuthProvider only checks `error.kind`, so
// this is enough to exercise the 'unauthorized' branch on mount.
const UNAUTHORIZED_ERROR = Object.assign(new Error('no session'), { kind: 'unauthorized' })
const DEMO_USER = { id: 'user-1', email: 'demo@example.com', displayName: 'Demo User' }

function LoginProbe() {
  const { state, login } = useAuth()
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <button onClick={() => void login({ email: 'demo@example.com', password: 'secret123' })}>login</button>
    </div>
  )
}

function StatusProbe() {
  const { state } = useAuth()
  return <span data-testid="status">{state.status}</span>
}

function LogoutProbe() {
  const { state, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <button onClick={() => void logout()}>logout</button>
    </div>
  )
}

/** Seeds one assistant conversation with one message and returns its id. */
function seedConversation(): string {
  const conversation = ensureActiveConversation()
  appendMessage(conversation.id, { role: 'user', content: 'Vercelで使いたい', status: 'done' })
  return conversation.id
}

function assistantMessageCount(): number {
  return getChatSnapshot().conversations.reduce((total, conversation) => total + conversation.messages.length, 0)
}

describe('AuthProvider sentinel-token compatibility shim', () => {
  beforeEach(() => {
    clearAccessToken()
    vi.mocked(sessionMe).mockReset()
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
      user: { getIdToken: async () => 'fake-firebase-id-token' },
    } as never)
  })

  it('writes a non-null, non-ID-token sentinel to tokenStorage after a successful login', async () => {
    vi.mocked(sessionMe)
      // Mount: no Cookie yet -> unauthenticated.
      .mockRejectedValueOnce(UNAUTHORIZED_ERROR)
      // Post-login: sessionLogin succeeded -> the Cookie is now valid.
      .mockResolvedValue(DEMO_USER)

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <LoginProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(readAccessToken()).toBeNull()

    await user.click(screen.getByRole('button', { name: 'login' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    const sentinel = readAccessToken()
    expect(sentinel).not.toBeNull()
    // Never the real Firebase ID token - see authApi.ts's SESSION_TOKEN_SENTINEL.
    expect(sentinel).not.toBe('fake-firebase-id-token')
  })

  it('writes the sentinel on the mount-time restore path too, not only on explicit login()', async () => {
    // Simulates a reload (or the very first check after signupApi's
    // completeSignup() established the Cookie directly, bypassing
    // AuthProvider entirely): a valid Cookie already exists, but this tab
    // never called login()/loginWithGoogle() itself, so nothing has written
    // the sentinel yet.
    vi.mocked(sessionMe).mockResolvedValue(DEMO_USER)
    expect(readAccessToken()).toBeNull()

    render(
      <MemoryRouter>
        <AuthProvider>
          <StatusProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(readAccessToken()).not.toBeNull()
  })
})

/**
 * browser-ai.md §7.3: the assistant conversation is dropped on every path that
 * leaves the `authenticated` state, but an unauthenticated visitor's
 * conversation must survive until the tab closes ("未認証ユーザーの会話はタブ
 * 終了まで保持する"). The mount-time session check 401s for every anonymous
 * visitor, so an unguarded clear there would wipe the conversation on every
 * reload.
 */
describe('AuthProvider assistant-conversation clearing (§7.3)', () => {
  beforeEach(() => {
    clearAccessToken()
    // resetChatStoreForTest() deliberately re-reads sessionStorage (it models a
    // reload), so the key has to go first for a truly empty starting point.
    window.sessionStorage.clear()
    resetChatStoreForTest()
    vi.mocked(sessionMe).mockReset()
  })

  it('keeps an anonymous visitor conversation when the mount-time session check 401s', async () => {
    vi.mocked(sessionMe).mockRejectedValue(UNAUTHORIZED_ERROR)
    seedConversation()
    expect(assistantMessageCount()).toBe(1)

    render(
      <MemoryRouter>
        <AuthProvider>
          <StatusProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(assistantMessageCount()).toBe(1)
  })

  it('clears the conversation when an authenticated user logs out', async () => {
    vi.mocked(sessionMe).mockResolvedValue(DEMO_USER)

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <LogoutProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    seedConversation()
    expect(assistantMessageCount()).toBe(1)

    await user.click(screen.getByRole('button', { name: 'logout' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(assistantMessageCount()).toBe(0)
  })

  it('clears the signup draft (registrar.signup.draft.v2) when an authenticated user logs out (issue #85)', async () => {
    vi.mocked(sessionMe).mockResolvedValue(DEMO_USER)
    window.sessionStorage.setItem('registrar.signup.draft.v2', JSON.stringify({ data: { name: '山田 太郎' } }))

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <LogoutProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(window.sessionStorage.getItem('registrar.signup.draft.v2')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'logout' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(window.sessionStorage.getItem('registrar.signup.draft.v2')).toBeNull()
  })

  it('keeps an anonymous visitor signup draft when the mount-time session check 401s (issue #85)', async () => {
    vi.mocked(sessionMe).mockRejectedValue(UNAUTHORIZED_ERROR)
    window.sessionStorage.setItem('registrar.signup.draft.v2', JSON.stringify({ data: { name: '山田 太郎' } }))

    render(
      <MemoryRouter>
        <AuthProvider>
          <StatusProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(window.sessionStorage.getItem('registrar.signup.draft.v2')).not.toBeNull()
  })

  it('clears the conversation when a live session expires (sessionMe 401 on recheck)', async () => {
    vi.mocked(sessionMe).mockResolvedValueOnce(DEMO_USER).mockRejectedValue(UNAUTHORIZED_ERROR)

    function RecheckProbe() {
      const { state, recheckSession } = useAuth()
      return (
        <div>
          <span data-testid="status">{state.status}</span>
          <button onClick={() => void recheckSession()}>recheck</button>
        </div>
      )
    }

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <RecheckProbe />
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    seedConversation()
    expect(assistantMessageCount()).toBe(1)

    await user.click(screen.getByRole('button', { name: 'recheck' }))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(assistantMessageCount()).toBe(0)
  })
})
