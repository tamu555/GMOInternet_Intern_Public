/**
 * Integration tests for /mypage/profile (docs/仕様/auth.md §4.8): profile
 * view/edit and provider-specific account deletion.
 *
 * `getMyProfile`/`updateMyProfile`/`deleteAccountWithPassword`/
 * `deleteAccountWithGoogle` are plain Callables, so they ride the fakeBackend
 * lane (`../api/callable` mocked to `fakeInvoke`) like the rest of マイページ
 * (mypageFlow.test.tsx). The Cookie session comes from
 * `installSessionFetchMock` (same helper every `<AppRouter />` test uses).
 * Client-side re-authentication (`reauthenticateWithCredential` /
 * `reauthenticateWithPopup`) is real Firebase Auth SDK surface, so
 * `firebase/auth` is mocked at the module level, mirroring authFlows.test.tsx
 * and GoogleAdditionalInfoPage.test.tsx.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/auth')>()
  return {
    ...actual,
    getAuth: vi.fn(actual.getAuth),
    connectAuthEmulator: vi.fn(),
    reauthenticateWithCredential: vi.fn(),
    reauthenticateWithPopup: vi.fn(),
  }
})

vi.mock('../api/callable', async () => {
  const { fakeInvoke } = await import('../test/fakeBackend')
  return { invoke: fakeInvoke }
})

import { FirebaseError } from 'firebase/app'
import { reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth'
import { ApiError } from '../api/apiError'
import { auth } from '../firebase/client'
import { installSessionFetchMock, type SessionFetchMock } from '../mocks/sessionFetchMock'
import { server } from '../mocks/server'
import { fakeBackend } from '../test/fakeBackend'
import type { MyProfile } from '../api/profileApi'
import { AppRouter } from './AppRouter'

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

const SEED_ADDRESS = {
  country: 'JP' as const,
  postalCode: '100-0001',
  prefecture: '東京都',
  city: '千代田区',
  addressLine: '千代田1-1-1',
  building: null,
}

const SEED_PROFILE: MyProfile['profile'] = {
  name: '山田 太郎',
  nameKana: 'ヤマダ タロウ',
  phoneNumber: '090-1234-5678',
  dateOfBirth: '1990-01-01',
  gender: 'male',
  newsletterOptIn: false,
  accountType: 'individual',
  business: null,
  address: SEED_ADDRESS,
}

function myProfile(overrides: Partial<MyProfile> = {}): MyProfile {
  return {
    uid: 'uid-1',
    email: 'demo@example.com',
    authProvider: 'password',
    status: 'active',
    profile: SEED_PROFILE,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Advances DeleteAccountDialog past its 'explain' step. The 次へ button
 * stays disabled until the dialog's own listDomains pre-check settles
 * (DeleteAccountDialog.tsx's `useDomainOwnershipCheck`), so this waits for
 * it to become enabled rather than assuming the fetch already resolved.
 */
async function clickNext(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  const nextButton = within(dialog).getByRole('button', { name: '次へ' })
  await waitFor(() => expect(nextButton).toBeEnabled())
  await user.click(nextButton)
}

function mockCurrentUser(overrides: { email?: string | null } = {}) {
  vi.spyOn(auth, 'currentUser', 'get').mockReturnValue({
    uid: 'uid-1',
    email: overrides.email ?? 'demo@example.com',
    getIdToken: vi.fn().mockResolvedValue('id-token'),
  } as unknown as typeof auth.currentUser)
}

let sessionMock: SessionFetchMock

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  fakeBackend.reset()
  sessionMock = installSessionFetchMock()
  fakeBackend.on('getMyProfile', () => myProfile())
  // fakeBackend.reset() seeds several domains by default (src/test/
  // fakeBackend.ts), which would otherwise block every 退会 flow below via
  // DeleteAccountDialog's own listDomains pre-check; the domain-ownership
  // describe block below overrides this per test.
  fakeBackend.on('listDomains', () => ({ domains: [] }))
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.restoreAllMocks()
})

describe('/mypage/profile: view & edit', () => {
  it('loads the profile and renders it in view mode', async () => {
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    expect(await screen.findByRole('heading', { name: 'プロフィール' })).toBeInTheDocument()
    expect(await screen.findByText('山田 太郎')).toBeInTheDocument()
    expect(screen.getByText('ヤマダ タロウ')).toBeInTheDocument()
    expect(screen.getByText('090-1234-5678')).toBeInTheDocument()
    expect(screen.getByText('demo@example.com')).toBeInTheDocument()
    expect(screen.getByText('メールアドレスとパスワード')).toBeInTheDocument()
    // No email/password change: no editable email field anywhere on the page.
    expect(screen.queryByLabelText('メールアドレス')).not.toBeInTheDocument()
  })

  it('edits the profile and submits updateMyProfile with the form values', async () => {
    let receivedPayload: Record<string, unknown> | null = null
    fakeBackend.on('updateMyProfile', (data) => {
      receivedPayload = (data as { profile: Record<string, unknown> }).profile
      return myProfile({ profile: { ...SEED_PROFILE, phoneNumber: '080-9999-8888' } })
    })

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '編集' }))
    const phoneInput = await screen.findByLabelText('電話番号')
    await user.clear(phoneInput)
    await user.type(phoneInput, '080-9999-8888')
    await user.click(screen.getByRole('button', { name: '保存する' }))

    await waitFor(() => expect(fakeBackend.callCount('updateMyProfile')).toBe(1))
    expect(await screen.findByText('プロフィールを更新しました。')).toBeInTheDocument()
    expect(screen.getByText('080-9999-8888')).toBeInTheDocument()
    expect(receivedPayload).not.toBeNull()
    expect((receivedPayload as unknown as { name: string }).name).toBe('山田 太郎')
    expect((receivedPayload as unknown as { phoneNumber: string }).phoneNumber).toBe('080-9999-8888')
  })

  it('shows a validation error and does not call updateMyProfile', async () => {
    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '編集' }))
    const nameInput = await screen.findByLabelText('名前（漢字）')
    await user.clear(nameInput)
    await user.click(screen.getByRole('button', { name: '保存する' }))

    expect(await screen.findByText('名前（漢字）を入力してください。')).toBeInTheDocument()
    expect(fakeBackend.callCount('updateMyProfile')).toBe(0)
  })
})

describe('/mypage/profile: 退会（アカウント削除）', () => {
  it('password account: reauthenticates, then calls deleteAccountWithPassword and signs out', async () => {
    const callOrder: string[] = []
    vi.mocked(reauthenticateWithCredential).mockImplementation(async () => {
      callOrder.push('reauth')
      return undefined as never
    })
    fakeBackend.on('deleteAccountWithPassword', () => {
      callOrder.push('delete')
      return {}
    })
    mockCurrentUser()

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')
    await clickNext(user, dialog)
    await user.type(within(dialog).getByLabelText('パスワード'), 'correct-password')
    await user.click(within(dialog).getByRole('button', { name: '退会する' }))

    await waitFor(() => expect(fakeBackend.callCount('deleteAccountWithPassword')).toBe(1))
    expect(callOrder).toEqual(['reauth', 'delete'])
    expect(await screen.findByText('AuthContext: 未認証')).toBeInTheDocument()
  })

  it('password account: a wrong password shows an error and does not call deleteAccountWithPassword', async () => {
    vi.mocked(reauthenticateWithCredential).mockRejectedValue(
      new FirebaseError('auth/wrong-password', 'The password is invalid.'),
    )
    fakeBackend.on('deleteAccountWithPassword', () => ({}))
    mockCurrentUser()

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')
    await clickNext(user, dialog)
    await user.type(within(dialog).getByLabelText('パスワード'), 'wrong-password')
    await user.click(within(dialog).getByRole('button', { name: '退会する' }))

    expect(await screen.findByText('パスワードが正しくありません。')).toBeInTheDocument()
    expect(fakeBackend.callCount('deleteAccountWithPassword')).toBe(0)
    // Still on the profile screen, still authenticated.
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })

  it('google account: reauthenticates with a popup, then calls deleteAccountWithGoogle and signs out', async () => {
    fakeBackend.on('getMyProfile', () => myProfile({ authProvider: 'google.com' }))
    const callOrder: string[] = []
    vi.mocked(reauthenticateWithPopup).mockImplementation(async () => {
      callOrder.push('reauth')
      return undefined as never
    })
    fakeBackend.on('deleteAccountWithGoogle', () => {
      callOrder.push('delete')
      return {}
    })
    mockCurrentUser()

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')
    await clickNext(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Googleで再認証して退会する' }))

    await waitFor(() => expect(fakeBackend.callCount('deleteAccountWithGoogle')).toBe(1))
    expect(callOrder).toEqual(['reauth', 'delete'])
    expect(await screen.findByText('AuthContext: 未認証')).toBeInTheDocument()
  })
})

describe('/mypage/profile: 退会（アカウント削除） — 保有ドメインによるブロック', () => {
  it('blocks the dialog while the member owns domains, and never reauthenticates or deletes', async () => {
    fakeBackend.on('listDomains', () => ({
      domains: [
        {
          name: 'owned-1.example.com',
          tld: 'com',
          registry: 'kitaqsign',
          status: ['ok'],
          rgpStatus: [],
          exDate: '2027-01-01T00:00:00.000Z',
          autoRenew: true,
          restorableUntil: null,
          restoreFeeYen: 0,
        },
        {
          name: 'owned-2.example.net',
          tld: 'net',
          registry: 'kitaqnic',
          status: ['ok'],
          rgpStatus: [],
          exDate: '2027-01-01T00:00:00.000Z',
          autoRenew: true,
          restorableUntil: null,
          restoreFeeYen: 0,
        },
      ],
    }))
    mockCurrentUser()
    // Earlier tests in this file already invoked these firebase/auth mocks;
    // capture the baseline instead of asserting "never called" outright.
    const reauthCredentialCallsBefore = vi.mocked(reauthenticateWithCredential).mock.calls.length
    const reauthPopupCallsBefore = vi.mocked(reauthenticateWithPopup).mock.calls.length

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')

    expect(
      await within(dialog).findByText('保有中のドメインが2件あるため退会できません。先にドメインを廃止または移管してください。'),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'ドメイン一覧へ' })).toHaveAttribute('href', '/mypage')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '次へ' })).toBeDisabled())

    // Clicking a disabled button is a no-op; the dialog must stay on 'explain'.
    await user.click(within(dialog).getByRole('button', { name: '次へ' }))
    expect(within(dialog).queryByLabelText('パスワード')).not.toBeInTheDocument()
    expect(vi.mocked(reauthenticateWithCredential).mock.calls.length).toBe(reauthCredentialCallsBefore)
    expect(vi.mocked(reauthenticateWithPopup).mock.calls.length).toBe(reauthPopupCallsBefore)
    expect(fakeBackend.callCount('deleteAccountWithPassword')).toBe(0)
    expect(fakeBackend.callCount('deleteAccountWithGoogle')).toBe(0)
  })

  it('does not block when every listed domain is gone (retired/transferred out)', async () => {
    fakeBackend.on('listDomains', () => ({
      domains: [
        {
          name: 'transferred-out.example.com',
          tld: 'com',
          registry: 'kitaqsign',
          status: ['gone'],
          rgpStatus: [],
          exDate: '2026-01-01T00:00:00.000Z',
          autoRenew: false,
          restorableUntil: null,
          restoreFeeYen: 0,
          lifecycle: 'gone',
          goneReason: 'transferred',
        },
        {
          name: 'redemption-expired.example.net',
          tld: 'net',
          registry: 'kitaqnic',
          status: ['pendingDelete'],
          rgpStatus: [],
          exDate: '2025-06-01T00:00:00.000Z',
          autoRenew: false,
          restorableUntil: null,
          restoreFeeYen: 0,
          lifecycle: 'gone',
          goneReason: 'unrecoverable',
        },
      ],
    }))
    vi.mocked(reauthenticateWithCredential).mockImplementation(async () => undefined as never)
    fakeBackend.on('deleteAccountWithPassword', () => ({}))
    mockCurrentUser()

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')
    // Two domains are listed, but both are 'gone': the block must not apply.
    await clickNext(user, dialog)
    expect(await within(dialog).findByLabelText('パスワード')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText('パスワード'), 'correct-password')
    await user.click(within(dialog).getByRole('button', { name: '退会する' }))

    await waitFor(() => expect(fakeBackend.callCount('deleteAccountWithPassword')).toBe(1))
    expect(await screen.findByText('AuthContext: 未認証')).toBeInTheDocument()
  })

  it('surfaces the backend domains_owned error identically, for a domain created after the pre-check passed', async () => {
    // The pre-check itself saw zero domains (fakeBackend's shared beforeEach
    // default); the deletion Callable is the one that catches the race.
    vi.mocked(reauthenticateWithCredential).mockImplementation(async () => undefined as never)
    fakeBackend.on('deleteAccountWithPassword', () => {
      throw new ApiError({
        kind: 'domainsOwned',
        status: 400,
        code: 'functions/failed-precondition',
        domainCount: 1,
      })
    })
    mockCurrentUser()

    const user = userEvent.setup()
    sessionMock.authenticate()
    renderApp('/mypage/profile')

    await user.click(await screen.findByRole('button', { name: '退会する' }))
    const dialog = await screen.findByRole('dialog')
    await clickNext(user, dialog)
    await user.type(within(dialog).getByLabelText('パスワード'), 'correct-password')
    await user.click(within(dialog).getByRole('button', { name: '退会する' }))

    expect(
      await within(dialog).findByText('保有中のドメインが1件あるため退会できません。先にドメインを廃止または移管してください。'),
    ).toBeInTheDocument()
    // Still on the profile screen, still authenticated - the account was not deleted.
    expect(screen.getByText('AuthContext: 認証済み')).toBeInTheDocument()
  })
})
