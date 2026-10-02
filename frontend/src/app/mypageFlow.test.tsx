/**
 * Integration tests for the my-page screens (docs/api-flow-diagrams.html
 * FIG.9-10): owned-domain list in two sections (§6.5), transfer-out
 * notifications (FIG.3 下帯), restore from pendingDelete (FIG.4) and the
 * auto-renew flag on the detail screen (§6.4). Drives the real router; domain
 * data comes from the fakeBackend callable fakes (myDomainsApi speaks Firebase
 * callables now), while the auth session stays on the MSW handlers.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsers } from '../mocks/db'
import { resetScenario, setScenario } from '../mocks/scenario'
import { server } from '../mocks/server'
import { installSessionFetchMock, type SessionFetchMock } from '../mocks/sessionFetchMock'
import { fakeBackend } from '../test/fakeBackend'
import { AppRouter } from './AppRouter'

vi.mock('../api/callable', async () => {
  const { fakeInvoke } = await import('../test/fakeBackend')
  return { invoke: fakeInvoke }
})

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

let sessionMock: SessionFetchMock

/**
 * Establishes the Cookie session `AuthProvider` now checks on every mount.
 * `sessionFetchMock.ts` transparently bridges the legacy bearer-token format
 * `mocks/handlers.ts`'s `authenticate()` still expects for domains/mypage
 * calls once `AuthProvider` writes `SESSION_TOKEN_SENTINEL` - see its doc
 * comment.
 */
function loginAsDemoUser() {
  sessionMock.authenticate()
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  resetUsers()
  fakeBackend.reset()
  resetScenario()
  setScenario({ latencyMs: 0 })
  sessionMock = installSessionFetchMock()
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.restoreAllMocks()
})

describe('FIG.9 マイページ一覧', () => {
  it('redirects to /login when logged out', async () => {
    renderApp('/mypage')
    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
  })

  it('splits domains into アクティブ / ライフサイクル終盤 with labelled statuses (§3.5 / §6.5)', async () => {
    loginAsDemoUser()
    renderApp('/mypage')

    expect(await screen.findByRole('heading', { name: 'アクティブ' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ライフサイクル終盤' })).toBeInTheDocument()

    // Colour never carries the meaning alone - the label text must be present.
    expect(screen.getByRole('link', { name: 'teamc-demo.com' })).toBeInTheDocument()
    expect(screen.getAllByText('使えています').length).toBeGreaterThan(0)
    expect(screen.getByText('まだインターネットに公開されていません')).toBeInTheDocument()
    expect(screen.getByText('解約手続き中です')).toBeInTheDocument()
    expect(screen.getByText('引っ越しの手続き中です')).toBeInTheDocument()

    // FIG.3 下帯: the seeded transfer-out request surfaces as a notice.
    expect(screen.getByText('移管申請が来ています')).toBeInTheDocument()
  })

  it('rejecting a transfer request clears pendingTransfer (FIG.3 下帯)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage')

    await user.click(await screen.findByRole('button', { name: '拒否する' }))

    expect(await screen.findByText('teamc-moving.xyz の移管申請を拒否しました。')).toBeInTheDocument()
    expect(screen.queryByText('移管申請が来ています')).not.toBeInTheDocument()
    expect(screen.queryByText('引っ越しの手続き中です')).not.toBeInTheDocument()
  })

  it('restores a pendingDelete domain after confirming in the dialog (FIG.4)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage')

    await user.click(await screen.findByRole('button', { name: /復旧する/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('ドメインを復旧しますか？')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /復旧する/ }))

    expect(await screen.findByText('teamc-old.icu を復旧しました。')).toBeInTheDocument()
    expect(screen.queryByText('解約手続き中です')).not.toBeInTheDocument()
  })

  it('counts down the days that are left while the domain is restorable', async () => {
    loginAsDemoUser()
    renderApp('/mypage')

    // The seeded pendingDelete domain has 23 days of redemptionPeriod left.
    expect(await screen.findByText('あと23日は戻せます')).toBeInTheDocument()
  })

  it('stops offering 復旧 once redemptionPeriod is gone (RGP の5日間)', async () => {
    // pendingDelete outlives redemptionPeriod by the five days during which
    // the registry answers 2304. Showing the button there walks the member
    // into a guaranteed failure.
    fakeBackend.on('listDomains', () => ({
      domains: [
        {
          name: 'teamc-old.icu',
          tld: '.icu',
          registry: 'kitaqnic',
          status: ['pendingDelete'],
          rgpStatus: [],
          exDate: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          autoRenew: false,
          restorableUntil: null,
          restoreFeeYen: 6000,
        },
      ],
    }))
    loginAsDemoUser()
    renderApp('/mypage')

    expect(await screen.findByText('復旧できる期間が終了しました')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /復旧する/ })).not.toBeInTheDocument()
  })

  it('shows a gone domain under 使用不可 with its reason, unlinked and ' +
    'without actions', async () => {
    // lifecycle "gone" = the member no longer holds the name (transferred
    // away, or purged past redemption). It must leave アクティブ, must not
    // link to the detail screen, and must offer no buttons: the same name
    // may already belong to someone else.
    fakeBackend.on('listDomains', () => ({
      domains: [
        {
          name: 'handed-over.com',
          tld: '.com',
          registry: 'kitaqsign',
          status: ['gone'],
          rgpStatus: [],
          exDate: new Date(Date.now() + 300 * 86_400_000).toISOString(),
          autoRenew: false,
          restorableUntil: null,
          restoreFeeYen: 8000,
          lifecycle: 'gone',
          goneReason: 'transferred',
        },
        {
          name: 'expired-away.net',
          tld: '.net',
          registry: 'kitaqsign',
          status: ['gone'],
          rgpStatus: [],
          exDate: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          autoRenew: false,
          restorableUntil: null,
          restoreFeeYen: 8000,
          lifecycle: 'gone',
          goneReason: 'unrecoverable',
        },
      ],
    }))
    loginAsDemoUser()
    renderApp('/mypage')

    const section = await screen.findByRole('region', { name: '使用不可' })
    expect(within(section).getByText('handed-over.com')).toBeInTheDocument()
    expect(within(section).getByText('移管済み')).toBeInTheDocument()
    expect(within(section).getByText('復旧不可')).toBeInTheDocument()

    // Not a link, no buttons — informational only.
    expect(within(section).queryByRole('link')).not.toBeInTheDocument()
    expect(within(section).queryByRole('button')).not.toBeInTheDocument()

    // And with every domain gone, アクティブ has nothing to show — the
    // section disappears instead of listing them as 利用中.
    expect(screen.queryByRole('heading', { name: 'アクティブ' }))
      .not.toBeInTheDocument()
  })

  it('never prints a negative countdown when the deadline has passed', async () => {
    fakeBackend.on('listDomains', () => ({
      domains: [
        {
          name: 'teamc-old.icu',
          tld: '.icu',
          registry: 'kitaqnic',
          status: ['pendingDelete'],
          // The status still says restorable, but the deadline is behind us:
          // the mirror simply has not been refreshed yet.
          rgpStatus: ['redemptionPeriod'],
          exDate: new Date(Date.now() - 7 * 86_400_000).toISOString(),
          autoRenew: false,
          restorableUntil: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          restoreFeeYen: 6000,
        },
      ],
    }))
    loginAsDemoUser()
    renderApp('/mypage')

    expect(await screen.findByText('復旧できる期間が終了しました')).toBeInTheDocument()
    expect(screen.queryByText(/あと-\d+日/)).not.toBeInTheDocument()
  })
})

describe('FIG.10 ドメイン詳細', () => {
  it('toggles the auto-renew flag (§6.4 アプリ内フラグ)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/domains/teamc-demo.com')

    const toggle = await screen.findByRole('switch', { name: '自動更新' })
    expect(toggle).toBeChecked()

    await user.click(toggle)

    expect(await screen.findByText('自動更新をOFFにしました。')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '自動更新' })).not.toBeChecked()
  })

  it('offers no copy button while no authInfo is held, and one right after ' +
    'a rotation', async () => {
    // The backend never returns a stored authInfo (§7.3), so until the
    // member rotates, there is nothing to copy — pressing コピー used to put
    // an empty string on the clipboard. Guidance replaces the mask instead.
    const user = userEvent.setup()
    fakeBackend.on('rotateAuthInfo', (data) => ({
      domainName: (data as { domainName: string }).domainName,
      registry: 'kitaqsign',
      authInfo: 'fresh-auth-code-123',
      rotatedAt: new Date().toISOString(),
      message: '認証コード（AuthCode）を再生成しました。以前のコードは使えません。',
    }))
    loginAsDemoUser()
    renderApp('/mypage/domains/teamc-demo.com')

    expect(
      await screen.findByText(/認証コードは保存されていないため表示できません/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'コピー' }))
      .not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /再生成する/ }))

    expect(await screen.findByRole('button', { name: 'コピー' }))
      .toBeInTheDocument()
    expect(
      screen.queryByText(/認証コードは保存されていないため表示できません/),
    ).not.toBeInTheDocument()

    // The rotation put the fresh code on the clipboard by itself and said so
    // (userEvent stubs the clipboard, so its contents are readable here).
    expect(
      await screen.findByText(/認証コードを再生成してコピーしました/),
    ).toBeInTheDocument()
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'fresh-auth-code-123',
    )
  })

  it('re-mints the AuthCode through the real rotateAuthInfo callable (§3.9 / §7.3)', async () => {
    // The backend stores no authInfo and getDomainInfo never returns one, so
    // this answer is the only copy the screen will ever hold: it has to reach
    // the copy button, and it must not be printed anywhere.
    const user = userEvent.setup()
    const requests: unknown[] = []
    fakeBackend.on('rotateAuthInfo', (data) => {
      requests.push(data)
      return {
        domainName: 'teamc-demo.com',
        registry: 'kitaqsign',
        authInfo: 'NEW-AUTH-CODE-0001',
        rotatedAt: new Date().toISOString(),
        message: '認証コード（AuthCode）を再生成しました。以前のコードは使えません。',
      }
    })
    loginAsDemoUser()
    renderApp('/mypage/domains/teamc-demo.com')

    await user.click(await screen.findByRole('button', { name: '再生成する' }))

    expect(
      await screen.findByText(
        '認証コードを再生成してコピーしました。古いコードは使えなくなります。'),
    ).toBeInTheDocument()
    expect(requests).toEqual([{ domainName: 'teamc-demo.com' }])

    expect(screen.queryByText('NEW-AUTH-CODE-0001')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'コピー' }))
    await expect(navigator.clipboard.readText()).resolves.toBe('NEW-AUTH-CODE-0001')
  })

  it('shows the spec-mandated NS warning before changing nameservers (§6.3.3)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/domains/teamc-demo.com')

    await user.click(await screen.findByRole('button', { name: 'ネームサーバーを変更' }))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。',
      ),
    ).toBeInTheDocument()
  })
})

describe('空き待ち通知 (docs/仕様/domain-watch.md)', () => {
  it('turns an available watch into the notice banner, with the mandatory caveat', async () => {
    loginAsDemoUser()
    fakeBackend.seedWatch('dream-name.com', 'available')
    renderApp('/mypage')

    expect(
      await screen.findByText('空き待ちのドメインが購入できるようになりました'),
    ).toBeInTheDocument()
    // The invitation must never read as a reservation (first come first served).
    expect(
      screen.getByText(
        '空き状況は変動する場合があります。他のお客様が先に取得されることもあるため、お早めにお手続きください。',
      ),
    ).toBeInTheDocument()
    // The CTA is the ordinary purchase flow, pre-targeted at the name.
    expect(screen.getByRole('link', { name: '購入手続きへ進む' })).toHaveAttribute(
      'href',
      '/domains/new?domain=dream-name.com',
    )
  })

  it('lists a watching entry with its deadline and can cancel it', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    fakeBackend.seedWatch('dream-name.com')
    renderApp('/mypage')

    expect(await screen.findByRole('heading', { name: '空き待ち通知' })).toBeInTheDocument()
    expect(screen.getByText(/空きを確認しています/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '解除' }))

    expect(await screen.findByText('dream-name.com の空き待ちを解除しました。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '空き待ち通知' })).not.toBeInTheDocument()
    expect(fakeBackend.watches()[0]?.state).toBe('cancelled')
  })

  it('cancelling from the banner removes the notice', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    fakeBackend.seedWatch('dream-name.com', 'available')
    renderApp('/mypage')

    await screen.findByText('空き待ちのドメインが購入できるようになりました')
    await user.click(screen.getByRole('button', { name: '空き待ちを解除' }))

    expect(await screen.findByText('dream-name.com の空き待ちを解除しました。')).toBeInTheDocument()
    expect(
      screen.queryByText('空き待ちのドメインが購入できるようになりました'),
    ).not.toBeInTheDocument()
  })
})
