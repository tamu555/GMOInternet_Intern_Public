/**
 * Integration tests for FIG.1's right half (docs/api-flow-diagrams.html):
 * application form (§6.2.6 defaults, folded advanced settings) -> pseudo
 * payment -> the 3-way result branch (done / retrying / failed) plus the
 * backend-side 2302 recovery, rendered through the real router. Orders and
 * search go through the fakeBackend callable fakes (ordersApi speaks Firebase
 * callables now); the auth session stays on the MSW handlers.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsers } from '../mocks/db'
import { resetScenario, setScenario } from '../mocks/scenario'
import { server } from '../mocks/server'
import { installSessionFetchMock, type SessionFetchMock } from '../mocks/sessionFetchMock'
import { fakeBackend, type FakeOrderOutcome } from '../test/fakeBackend'
import { AppRouter } from './AppRouter'

vi.mock('../api/callable', async () => {
  const { fakeInvoke } = await import('../test/fakeBackend')
  return { invoke: fakeInvoke }
})

// Read lazily by config.orderPollIntervalMs() on every poll, so assigning here
// speeds up the whole suite without touching production code paths.
import.meta.env.VITE_ORDER_POLL_INTERVAL_MS = '25'

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

let sessionMock: SessionFetchMock

/**
 * Establishes the Cookie session `AuthProvider` now checks on every mount.
 * `sessionFetchMock.ts` transparently bridges the legacy bearer-token format
 * `mocks/handlers.ts`'s `authenticate()` still expects for domains/orders
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
  loginAsDemoUser()
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.restoreAllMocks()
})

/** Chooses クレジットカード and fills it via 「ダミー値を入力」 so 支払う succeeds. */
async function fillDummyPayment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: 'クレジットカード / デビットカード' }))
  await user.click(await screen.findByRole('button', { name: 'ダミー値を入力' }))
}

/** Walks form -> confirm -> pay and returns the user-event instance. */
async function payForDomain(domain: string, outcome: FakeOrderOutcome = 'success') {
  fakeBackend.setOrderOutcome(outcome)
  const user = userEvent.setup()
  renderApp(`/domains/new?domain=${domain}`)

  await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
  await fillDummyPayment(user)
  await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
  return user
}

/**
 * Same walk, but the member opens the fold and types nameservers - the only
 * way an order carries any, now that there is no default DNS to fall back on.
 */
async function payWithNameservers(
  domain: string,
  nameservers: string[],
  outcome: FakeOrderOutcome = 'success',
) {
  fakeBackend.setOrderOutcome(outcome)
  const user = userEvent.setup()
  renderApp(`/domains/new?domain=${domain}`)

  await user.click(await screen.findByRole('button', { name: /くわしい設定/ }))
  await user.click(screen.getByRole('radio', { name: /他社のネームサーバを指定する/ }))
  for (const [index, host] of nameservers.entries()) {
    await user.type(screen.getByLabelText(index === 0 ? 'ネームサーバ1' : `ネームサーバ${index + 1}（任意）`), host)
  }
  await user.click(screen.getByRole('button', { name: '確認画面へ進む' }))
  await fillDummyPayment(user)
  await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
  return user
}

describe('FIG.1 申込フォーム (§6.2.6 defaults)', () => {
  it('pre-fills every §6.2.6 default and folds the advanced fields instead of dropping them', async () => {
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    expect(await screen.findByRole('heading', { name: '申込フォーム' })).toBeInTheDocument()
    expect(screen.getByLabelText('登録期間')).toHaveValue('1')
    expect(screen.getByRole('checkbox', { name: /自動更新/ })).toBeChecked()
    // §6.2.5: first-year and renewal figures both present (same-size is CSS).
    expect(screen.getByText('初年度')).toBeInTheDocument()
    expect(screen.getByText('2年目以降 毎年')).toBeInTheDocument()
    expect(screen.getByText('3年間の合計')).toBeInTheDocument()

    // Folded ("たたむ"), not gone: opening the fold reveals the pre-filled values.
    expect(screen.queryByLabelText('認証コード（authInfo）')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /くわしい設定/ }))
    const authInfoInput = screen.getByLabelText('認証コード（authInfo）') as HTMLInputElement
    expect(authInfoInput.value.length).toBeGreaterThanOrEqual(20)
    // No default DNS: the form asks for no nameserver unless the member types one.
    expect(screen.getByRole('radio', { name: /いまは設定しない/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /登録者と同じコンタクト/ })).toBeChecked()
  })

  it('force-opens the fold when a folded field fails validation (§1.2 accident guard)', async () => {
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: /くわしい設定/ }))
    await user.clear(screen.getByLabelText('認証コード（authInfo）'))
    await user.click(screen.getByRole('button', { name: /くわしい設定/ })) // fold it back
    await user.click(screen.getByRole('button', { name: '確認画面へ進む' }))

    expect(await screen.findByText('認証コード（authInfo）は1〜64文字で入力してください。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'お申し込み内容の確認' })).not.toBeInTheDocument()
  })

  it('sends the user back to search when no domain was handed over', async () => {
    renderApp('/domains/new')
    expect(await screen.findByText(/申し込むドメインを特定できませんでした/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'ドメイン検索へ戻る' })).toBeInTheDocument()
  })

  it('receives the domain chosen on the search screen', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.type(await screen.findByLabelText('取得したいドメイン名'), 'myshop')
    await user.click(screen.getByRole('button', { name: '検索する' }))
    await user.click(await screen.findByRole('button', { name: 'myshop.com を選択' }))
    await user.click(screen.getByRole('link', { name: '次へ進む' }))

    expect(await screen.findByRole('heading', { name: '申込フォーム' })).toBeInTheDocument()
    expect(screen.getByText('myshop.com')).toBeInTheDocument()
  })
})

describe('FIG.1 疑似決済 -> 完了 (success path)', () => {
  it('confirms, pays, shows the in-flight state, then the completion screen', async () => {
    fakeBackend.setOrderOutcome('success')
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
    expect(await screen.findByRole('heading', { name: 'お申し込み内容の確認' })).toBeInTheDocument()
    expect(screen.getByText(/これは疑似決済です。実際の請求・課金は発生しません/)).toBeInTheDocument()

    await fillDummyPayment(user)
    await user.click(screen.getByRole('button', { name: '支払う（疑似決済）' }))

    // Order.state is 4-valued: the in-flight phase renders its own screen.
    expect(await screen.findByRole('heading', { name: '注文を処理しています' })).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    // No nameserver was requested, so the domain is registered as `inactive`
    // (§3.5) and the completion screen hands off to the DNS settings.
    expect(screen.getByText('まだインターネットに公開されていません')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DNS設定に進む' })).toBeInTheDocument()
    expect(window.location.pathname).toMatch(/^\/orders\//)
  })

  it('shows 使えています when the member did supply nameservers', async () => {
    await payWithNameservers('myshop.com', ['ns1.example.com', 'ns2.example.com'])

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    expect(screen.getByText('使えています')).toBeInTheDocument()
    expect(fakeBackend.orders()[0]?.nameservers).toEqual(['ns1.example.com', 'ns2.example.com'])
  })

  it('masks authInfo (§7.3): the value is never rendered, the copy button provides it', async () => {
    const user = await payForDomain('myshop.com')
    await screen.findByRole('heading', { name: 'ドメインを取得しました' })

    const authInfo = fakeBackend.orders()[0]?.authInfo ?? ''
    expect(authInfo.length).toBeGreaterThanOrEqual(20)
    expect(screen.queryByText(authInfo)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'コピー' }))
    expect(await screen.findByText('認証コードをコピーしました。')).toBeInTheDocument()
    await expect(navigator.clipboard.readText()).resolves.toBe(authInfo)
  })

  it('creates exactly one order even when 支払う is double-clicked', async () => {
    fakeBackend.setOrderOutcome('success')
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
    await fillDummyPayment(user)
    await user.dblClick(await screen.findByRole('button', { name: '支払う（疑似決済）' }))

    await screen.findByRole('heading', { name: 'ドメインを取得しました' })
    expect(fakeBackend.orders()).toHaveLength(1)
  })

  it('recovers the result screen from the order id after a reload without re-ordering', async () => {
    await payForDomain('myshop.com')
    await screen.findByRole('heading', { name: 'ドメインを取得しました' })
    const orderId = fakeBackend.orders()[0]?.id ?? ''

    cleanup() // "reload": tear the app down and boot it again on the order URL
    renderApp(`/orders/${orderId}`)

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    expect(fakeBackend.orders()).toHaveLength(1)
  })
})

describe('FIG.1 3分岐 + 2302 recovery', () => {
  it('retrying: shows the §6.7 wording and the no-double-charge assurance, then completes', async () => {
    await payForDomain('myshop.com', 'retry-then-success')

    expect(await screen.findByText(/処理中です。自動で再試行しています/)).toBeInTheDocument()
    expect(screen.getByText(/お支払いが二重に発生することはありません/)).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
  })

  it('failed: says 処理できませんでした and never mentions the internal refund treatment (§5)', async () => {
    await payForDomain('myshop.com', 'retry-then-fail')

    expect(await screen.findByText(/処理できませんでした/)).toBeInTheDocument()
    expect(screen.getByText(/このご注文の料金が請求されることはありません/)).toBeInTheDocument()
    expect(screen.queryByText(/返金/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'ドメインを取得しました' })).not.toBeInTheDocument()
  })

  it('2302 recovery: indistinguishable from a plain success on screen (§6.7 / FIG.2)', async () => {
    await payForDomain('myshop.com', 'recovered-2302')

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    // The UI must not leak "this was actually a retry".
    expect(screen.queryByText(/再試行/)).not.toBeInTheDocument()
    expect(screen.queryByText(/リトライ/)).not.toBeInTheDocument()
    expect(screen.getByText('まだインターネットに公開されていません')).toBeInTheDocument()
  })

  it('NS update failed: the domain is still acquired, only the delegation is missing', async () => {
    await payWithNameservers('myshop.com', ['ns1.example.com'], 'ns-update-failed')

    // The post-create domain:update is outside the purchase: its failure must
    // never turn a paid order into 「取得できませんでした」.
    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    // Exact match hits the status tag; the banner phrases it in a sentence.
    expect(screen.getByText('まだインターネットに公開されていません')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DNS設定に進む' })).toBeInTheDocument()
  })

  it('500 on order creation: stays on the confirm step and allows another attempt', async () => {
    await payForDomain('myshop.com', 'server-error')

    expect(await screen.findByText('時間をおいて再度お試しください。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '支払う（疑似決済）' })).toBeEnabled()
    expect(fakeBackend.orders()).toHaveLength(0)
  })
})

describe('FIG.1 決済手段の必須ゲート (dummy payment)', () => {
  it('決済手段を選ばずに「支払う（疑似決済）」を押しても注文が作られない', async () => {
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
    await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))

    expect(await screen.findByText('お支払い方法を選択してください。')).toBeInTheDocument()
    expect(fakeBackend.orders()).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'お申し込み内容の確認' })).toBeInTheDocument()
  })

  it('カード番号が不正なまま支払うと注文が作られない', async () => {
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
    await user.click(await screen.findByRole('radio', { name: 'クレジットカード / デビットカード' }))
    // Luhn-invalid: the well-known 4242…4242 test number with its last digit
    // flipped, which is never doubled by the checksum so the sum shifts by 1.
    await user.type(await screen.findByLabelText('カード番号'), '4242 4242 4242 4241')
    await user.click(screen.getByRole('button', { name: '支払う（疑似決済）' }))

    // Only the card-number field was touched, so its own error - and its
    // role="alert" wiring - is the one to assert on (other required fields
    // also error, which findByRole('alert') alone cannot disambiguate).
    const cardNumberError = await screen.findByText('カード番号の形式が正しくありません。')
    expect(cardNumberError.closest('[role="alert"]')).not.toBeNull()
    expect(fakeBackend.orders()).toHaveLength(0)
  })

  it.each([
    'クレジットカード / デビットカード',
    'コンビニ決済',
    '銀行振込',
    '口座振替',
    'キャリア決済',
    'QRコード・スマホ決済',
    'PayPal',
    'Amazon Pay',
  ])('ダミー値を入力してから支払うと注文が1件だけ作られる（%s）', async (methodLabel) => {
    fakeBackend.setOrderOutcome('success')
    const user = userEvent.setup()
    renderApp('/domains/new?domain=myshop.com')

    await user.click(await screen.findByRole('button', { name: '確認画面へ進む' }))
    await user.click(await screen.findByRole('radio', { name: methodLabel }))
    await user.click(await screen.findByRole('button', { name: 'ダミー値を入力' }))
    await user.click(screen.getByRole('button', { name: '支払う（疑似決済）' }))

    await screen.findByRole('heading', { name: 'ドメインを取得しました' })
    expect(fakeBackend.orders()).toHaveLength(1)
  })
})
