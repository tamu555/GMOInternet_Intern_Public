/**
 * Integration tests for the transfer-in flow (spec §6.6.2, 通常モード):
 * my-page entry → request form → pendingTransfer progress on my-page →
 * cancel / rejection notice. Same harness as mypageFlow.test.tsx: real router,
 * fakeBackend callables, MSW for the auth session.
 *
 * The fakes speak the REAL wire shapes (`requestTransfer` / `cancelTransfer` /
 * `listTransfers` / `getTransferStatus`, all keyed by domainName), so the
 * adapter in api/transferApi.ts stays under test.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsers } from '../mocks/db'
import { resetScenario, setScenario } from '../mocks/scenario'
import { server } from '../mocks/server'
import { installSessionFetchMock, type SessionFetchMock } from '../mocks/sessionFetchMock'
import { ensureTransferNotificationsDrained } from '../api/transferApi'
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

/** Cookie-session login, same bridge as mypageFlow.test.tsx (sessionFetchMock.ts). */
function loginAsDemoUser() {
  sessionMock.authenticate()
}

async function submitRequest(user: ReturnType<typeof userEvent.setup>, domainName: string) {
  await user.type(await screen.findByLabelText('移管したいドメイン名'), domainName)
  await user.type(screen.getByLabelText('AuthCode（認証コード）'), 'K9#demo-auth-code')
  await user.click(screen.getByRole('button', { name: '移管を申請する' }))
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

describe('§6.6.2 移管INの申請フォーム', () => {
  it('is reachable from the my-page entry button', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage')

    await user.click(await screen.findByRole('link', { name: '他社から移管する' }))

    expect(
      await screen.findByRole('heading', { name: '他社からドメインを移管する' }),
    ).toBeInTheDocument()
    // §6.6.2 step 2: the AuthCode issuance guide is part of the form screen.
    expect(screen.getByText('AuthCode（認証コード）を用意してください')).toBeInTheDocument()
  })

  it('validates both fields before calling the backend (§3.4)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/transfer')

    await user.click(await screen.findByRole('button', { name: '移管を申請する' }))

    expect(await screen.findByText('移管したいドメイン名を入力してください。')).toBeInTheDocument()
    expect(screen.getByText('AuthCode（認証コード）を入力してください。')).toBeInTheDocument()
    expect(fakeBackend.pendingTransferIns()).toHaveLength(0)
  })

  it('submits a request and shows the pending hand-off (§6.6.2 step 4)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/transfer')

    await submitRequest(user, 'moved-in.net')

    expect(await screen.findByText('移管を申請しました')).toBeInTheDocument()
    expect(screen.getByText('moved-in.net')).toBeInTheDocument()
    // ⚠️ §6.6.1: 20分の自動承認期限をその場で伝える.
    expect(screen.getByText(/レジストリが自動で承認します。$/)).toBeInTheDocument()
    expect(fakeBackend.pendingTransferIns()).toHaveLength(1)
    expect(fakeBackend.pendingTransferIns()[0]).toMatchObject({
      domainName: 'moved-in.net',
      direction: 'in',
      state: 'pending',
    })
  })

  it('surfaces the 2202-style authInfo mismatch as a field error (§6.7)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/transfer')

    await submitRequest(user, 'wrong-auth.net')

    expect(
      await screen.findByText(
        '認証コード（AuthCode）が違うようです。移管元の管理画面でもう一度ご確認ください。',
      ),
    ).toBeInTheDocument()
    expect(fakeBackend.pendingTransferIns()).toHaveLength(0)
  })

  it('rejects a domain we already hold', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/transfer')

    await submitRequest(user, 'teamc-demo.com')

    expect(
      await screen.findByText('このドメインはすでにお客様が当サービスで管理しています。'),
    ).toBeInTheDocument()
  })

  it('names the ドメイン名 field when the TLD is not supported', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    renderApp('/mypage/transfer')

    await submitRequest(user, 'moved-in.example')

    expect(
      await screen.findByText('このドメインのTLDは当サービスでは取り扱っていません。'),
    ).toBeInTheDocument()
    expect(fakeBackend.pendingTransferIns()).toHaveLength(0)
  })
})

/**
 * ⚠️ 2026-08-28 の回帰。移管IN区画だけがキューのドレインを待たずに
 * `listTransfers` を読んでいたため、同じ画面のドメイン一覧（ドレイン後）と
 * 状態が食い違い、リロードのたびに移管の状態が変わって見えていた。
 */
describe('移管状態の読み取り順序', () => {
  it('移管IN区画はキューのドレインが終わってから読む（ドレインは1回だけ）', async () => {
    const drainCalls: number[] = []
    let drained = false
    let listedWhileUndrained = 0

    fakeBackend.on('drainPollQueue', async () => {
      drainCalls.push(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      drained = true
      return { results: [], reconcile: {} }
    })
    fakeBackend.on('listTransfers', () => {
      if (!drained) listedWhileUndrained += 1
      return { transfers: [] }
    })

    loginAsDemoUser()
    renderApp('/mypage')
    expect(await screen.findByRole('heading', { name: 'アクティブ' })).toBeInTheDocument()

    // マイページ本体と移管IN区画のどちらも、ドレイン後の状態だけを読んでいる。
    expect(listedWhileUndrained).toBe(0)
    // 2 つの区画が同時に立ち上がっても、レジストリを叩くのは 1 回。
    // ⚠️ この行だけでは共有の証明にならない（区画がドレインを呼ばなかった昔の
    //   コードでも 1 になる）。共有そのものは下の単体テストが受け持つ。
    expect(drainCalls).toHaveLength(1)
  })

  /**
   * 上の統合テストが証明できない側 — 「2 人が同時に呼んでも 1 回」を直接見る。
   * ⚠️ ensureTransferNotificationsDrained はモジュール変数で実行中の Promise を
   * 共有するので、この 2 呼び出しは **await を挟まずに** 並べること。あいだで
   * await すると 1 本目が解決してしまい、共有ではなく順番待ちを見ることになる。
   */
  it('同時に呼ばれてもドレインは 1 回しか投げない', async () => {
    let calls = 0
    fakeBackend.on('drainPollQueue', async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { results: [], reconcile: {} }
    })
    loginAsDemoUser()

    await Promise.all([
      ensureTransferNotificationsDrained(),
      ensureTransferNotificationsDrained(),
      ensureTransferNotificationsDrained(),
    ])

    expect(calls).toBe(1)

    // 流し終わったあとの呼び出しは、新しいドレインとして投げ直される
    // （時間でキャッシュしない ＝ 押した直後に古い状態を見せない）。
    await ensureTransferNotificationsDrained()
    expect(calls).toBe(2)
  })
})

describe('マイページの移管IN進捗区画', () => {
  /**
   * Walks the real 導線 (§6.6.2 step 4): 申請フォーム → 「マイページで進捗を見る」.
   * Going through the UI matters now — the section rebuilds FIG.9's 結果行 from
   * `getTransferStatus`, and the browser only knows which domain to ask about
   * because the request screen put it on the watchlist (transferWatchlist.ts).
   */
  async function requestThenOpenMyPage(
    user: ReturnType<typeof userEvent.setup>,
    domainName: string,
    settle?: 'completed' | 'rejected',
  ) {
    renderApp('/mypage/transfer')
    await submitRequest(user, domainName)
    expect(await screen.findByText('移管を申請しました')).toBeInTheDocument()
    // Registrar B answers outside the app (§6.6.1) while the user is elsewhere.
    if (settle) fakeBackend.settleTransferIn(domainName, settle)
    await user.click(screen.getByRole('link', { name: 'マイページで進捗を見る' }))
  }

  it('shows the pending request and cancels it after confirming (§6.6.1 cancel)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    await requestThenOpenMyPage(user, 'moved-in.net')

    expect(await screen.findByText('移管の手続き中')).toBeInTheDocument()
    expect(screen.getByText('moved-in.net')).toBeInTheDocument()
    expect(screen.getByText('移管元の承認待ちです')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '申請を取り下げる' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('移管の申請を取り下げますか？')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '申請を取り下げる' }))

    expect(await screen.findByRole('heading', { name: 'アクティブ' })).toBeInTheDocument()
    expect(screen.queryByText('移管の手続き中')).not.toBeInTheDocument()
    expect(fakeBackend.pendingTransferIns()).toHaveLength(0)
  })

  it('shows a rejection notice that can be closed', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    await requestThenOpenMyPage(user, 'moved-in.net', 'rejected')

    expect(await screen.findByText('移管元に拒否されました')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '閉じる' }))

    expect(await screen.findByRole('heading', { name: 'アクティブ' })).toBeInTheDocument()
    expect(screen.queryByText('移管元に拒否されました')).not.toBeInTheDocument()
  })

  it('a completed transfer shows a closable completion row AND the owned domain', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    await requestThenOpenMyPage(user, 'moved-in.net', 'completed')

    // Completion stays visible until closed (the real import may lag behind).
    expect(await screen.findByText('移管が完了しました')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'moved-in.net' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '閉じる' }))

    expect(await screen.findByRole('heading', { name: 'アクティブ' })).toBeInTheDocument()
    expect(screen.queryByText('移管が完了しました')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'moved-in.net' })).toBeInTheDocument()
  })
})
