/**
 * かんたんモード（/easy/*）の統合フローテスト。
 *
 * 目的の選択 → ドメイン名 → 末尾 → 内容確認 → 支払い → easyDNS 設定 → 完了 を
 * 実ルーターで通す。注文・検索・DNS は fakeBackend（callable の in-memory fake）、
 * セッションは MSW という既存の 2 層構成をそのまま使う（新しいモック機構は
 * 作らない）。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetUsers } from '../mocks/db'
import { resetScenario, setScenario } from '../mocks/scenario'
import { server } from '../mocks/server'
import { installSessionFetchMock, type SessionFetchMock } from '../mocks/sessionFetchMock'
import { fakeBackend } from '../test/fakeBackend'
import { ORDER_FORM_DEFAULTS } from '../features/orders/orderDefaults'
/* ⚠️ 文言は easyMessages.ts が正。ここへ逐語でコピーすると、文を 1 文字縮める
   たびに 10 か所のテストが落ちる（実際に 2026-08-27 の圧縮で 11 件落ちた）。
   このテストが守りたいのは「その画面にその案内が出ていること」であって、
   文字列そのものではないので、定数を参照して置き場所だけを検証する。 */
import {
  AUTO_RENEW_OFF_SUMMARY,
  ENTRY_HEADING,
  ENTRY_RESTART_ACTION,
  ENTRY_RESUME_ACTION,
  GOAL_HEADING,
  autoRenewOnNote,
  autoRenewOnSummary,
  DNS_CHECK_DONE_NOTE,
  DNS_NO_TARGET_BODY,
  DNS_NO_TARGET_MAIL_EXAMPLES,
  DNS_NO_TARGET_SAFE_NOTE,
  DNS_NO_TARGET_WEB_EXAMPLES,
  DNS_NS_GUIDE_FRESH_NOTE,
  DNS_NS_GUIDE_LATER_NOTE,
  DNS_SAVED_WAIT_BODY,
  DONE_DNS_SKIPPED_NOTE,
  DONE_PROPAGATION_NOTE,
  GOAL_MORE_ACTION,
  LOGIN_REQUIRED_NOTICE,
  NAME_HEADING,
  NAME_JARGON_NOTE,
  NAME_RESULTS_HEADING,
  NAME_SEARCH_ACTION,
  PAYMENT_LEDE,
  paymentChargedLabel,
} from '../features/easy/easyMessages'
import { AppRouter } from './AppRouter'

vi.mock('../api/callable', async () => {
  const { fakeInvoke } = await import('../test/fakeBackend')
  return { invoke: fakeInvoke }
})

/* ステップ3に埋め込んだログインフォームは本物の Firebase SDK を叩くので、
   authFlows.test.tsx と同じやり方でサインインだけ差し替える（Cookie セッション
   側は installSessionFetchMock がそのまま受ける）。 */
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

import { signInWithEmailAndPassword } from 'firebase/auth'

import.meta.env.VITE_ORDER_POLL_INTERVAL_MS = '25'

function renderApp(initialPath: string) {
  window.history.pushState({}, '', initialPath)
  return render(<AppRouter />)
}

/* シェルのヘッダー。⚠️ `getByRole('banner')` は使えない — 各ページの見出しも
   `<header>` なので、同じ role が 1 画面に複数ある。DOM 上いちばん先頭の
   `<header>` がシェルのものだと決めておく。 */
function appHeader(): HTMLElement {
  const header = document.querySelector('header')
  if (!header) throw new Error('app header not rendered')
  return header as HTMLElement
}

let sessionMock: SessionFetchMock

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

/**
 * 目的 → 名前 → 末尾 の 3 ステップを進める。
 *
 * 各ステップは「選ぶ → 次へ」の 1 主要ボタン形式。入力した名前とおすすめの末尾は
 * 初期選択されるので、選び直さずに「次へ」で進めることも確認している。
 */
async function walkToTld(user: ReturnType<typeof userEvent.setup>, label = 'my-bakery') {
  await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
  await user.click(screen.getByRole('button', { name: /^次へ/ }))

  const input = await screen.findByLabelText('使いたい名前')
  await user.clear(input)
  await user.type(input, label)
  await user.click(screen.getByRole('button', { name: NAME_SEARCH_ACTION }))

  // 入力した名前が候補の先頭に来て、そのまま選ばれている。
  const typed = await screen.findByRole('radio', { name: new RegExp(`^${label}[^a-z0-9-]`) })
  expect(typed).toBeChecked()
  await user.click(screen.getByRole('button', { name: /^次へ/ }))

  // おすすめの末尾（.com）も初期選択。明示的に選んでおく。
  await user.click(await screen.findByRole('radio', { name: new RegExp(`${label}\\.com`) }))
}

async function walkToConfirm(user: ReturnType<typeof userEvent.setup>, label = 'my-bakery') {
  await walkToTld(user, label)
  await user.click(screen.getByRole('button', { name: /^次へ/ }))
}

/** クレジットカードを選び、「ダミー値を入力」で 支払う が通る状態にする。 */
async function fillDummyPayment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: 'クレジットカード / デビットカード' }))
  await user.click(await screen.findByRole('button', { name: 'ダミー値を入力' }))
}

/** 目的 → 名前 → 末尾 → 確認 → 支払い を通して easyDNS 設定画面まで進める。 */
async function walkToDns(user: ReturnType<typeof userEvent.setup>) {
  await walkToConfirm(user)
  await user.click(await screen.findByRole('button', { name: /お支払いに進む/ }))
  await fillDummyPayment(user)
  await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
  await screen.findByRole('heading', { name: 'ドメインをつなぐ' })
}

describe('かんたんモードの入口', () => {
  /**
   * ⚠️ 通常モードへの帰り道はブランドリンク（＝トップページ）1 本だけ
   * （2026-08-28）。ステップ本文にあった「通常モードに切り替える」は、
   * トップへ戻れば同じことができるので廃止した — 補助リンクが 4 本並ぶと、
   * どれが「進む」なのかが読み取れなくなる。
   */
  it('トップページからかんたんモードを開始でき、トップへ戻れる', async () => {
    const user = userEvent.setup()
    renderApp('/')

    // フッターにも導線があるので、トップの切り替えスイッチを指名する。
    const modeSwitch = await screen.findByRole('group', { name: 'モードの切り替え' })
    await user.click(within(modeSwitch).getByRole('link', { name: /かんたんモード/ }))

    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')

    await user.click(within(appHeader()).getByRole('link', { name: /ゼロからドメイン/ }))
    expect(window.location.pathname).toBe('/')
  })

  /**
   * ステップの操作行（＝本文）に残るのは「戻る」だけ。モードの出口は本文では
   * なくヘッダーが持つので、`main` に絞って検証する（issue #91 以降、
   * ヘッダーにも「通常モードに戻る」が常時出ている）。
   */
  it('ステップの操作行には「戻る」以外の補助リンクを出さない', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    // 目的を選んで 2 ステップ目へ（1 ステップ目は帰る先が無く操作行を出さない）。
    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))

    expect(await screen.findByRole('heading', { name: NAME_HEADING })).toBeInTheDocument()
    const body = within(screen.getByRole('main'))
    expect(body.getByRole('link', { name: /戻る/ })).toBeInTheDocument()
    expect(body.queryByRole('link', { name: /通常モード/ })).toBeNull()
    expect(body.queryByRole('button', { name: /最初からやり直す/ })).toBeNull()
    expect(body.queryByRole('button', { name: /保存してあとで続ける/ })).toBeNull()
  })

  /**
   * ⚠️ モードの「切り替え」（2 択のトグル）はヘッダーのバーには出さない
   * （2026-08-28）。行き先リンクと同じ 1 組の選択肢に見えて、いま自分がどちらの
   * モードに居るのかがかえって読めなくなったため。切り替えはトップページ本文の
   * `EasyModeSwitch` だけが持つ。
   *
   * かんたんモードのページでだけ例外的にヘッダーへ出るのは、現在地の表示と
   * **出口 1 本**（issue #91）。ページの一番下まで下りないと通常モードへ戻れない、
   * という状態を解いたのがこれなので、sticky なヘッダーの中にあること自体が要件。
   */
  it('通常モードのヘッダーにはモードの導線が 1 つも出ない', () => {
    renderApp('/')
    expect(within(appHeader()).queryByRole('group', { name: 'モードの切り替え' })).toBeNull()
    expect(within(appHeader()).queryByRole('link', { name: /かんたん/ })).toBeNull()
    expect(within(appHeader()).queryByRole('link', { name: /通常/ })).toBeNull()
    // 未ログインのバーに出る行き先は 1 つも無い（マイページも出ない）。
    expect(within(appHeader()).queryByRole('link', { name: 'マイページ' })).toBeNull()
  })

  it('かんたんモードのヘッダーにはモードの表示を出さない（2026-08-28 削除）', () => {
    renderApp('/easy/goal')
    const header = within(appHeader())
    // 2 択のトグルにも、現在地バッジ＋「通常モードに戻る」出口にも戻さない
    // （バーに通常/かんたんの文字が並ぶこと自体が余計、という利用者の指摘）。
    expect(header.queryByRole('group', { name: 'モードの切り替え' })).toBeNull()
    expect(header.queryByText(/かんたんモード/)).toBeNull()
    expect(header.queryByRole('link', { name: /通常モード/ })).toBeNull()
    expect(header.queryByRole('link', { name: 'マイページ' })).toBeNull()
  })

  /**
   * トップページ＝やり直しの起点（2026-08-28）。前回の入力が残っていると、
   * 次に「かんたん」を開いた人が身に覚えのない続きから再開させられる。
   */
  it('トップページに戻ると、かんたんモードの入力途中の下書きは破棄される', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(await screen.findByRole('heading', { name: NAME_HEADING })).toBeInTheDocument()

    // ヘッダーのブランドリンクでトップへ（バーからトップへ戻る導線はこれだけ）。
    await user.click(within(appHeader()).getByRole('link', { name: /ゼロからドメイン/ }))
    expect(window.location.pathname).toBe('/')
    await screen.findByRole('group', { name: 'モードの切り替え' })

    expect(
      Object.keys(window.localStorage).filter((key) => key.startsWith('registrar.easy.session')),
    ).toEqual([])

    // 戻ると 1 ステップ目からのやり直しになる（続きに飛ばされない）。
    await user.click(
      within(screen.getByRole('group', { name: 'モードの切り替え' })).getByRole('link', {
        name: /かんたんモード/,
      }),
    )
    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')
  })

  it('空のセッションでウィザードを開いてもバックエンド呼び出しを一切行わない', async () => {
    const calls: string[] = []
    for (const name of ['searchDomains', 'listTlds', 'getOrder', 'getDomainInfo']) {
      fakeBackend.on(name, () => {
        calls.push(name)
        throw new Error(`unexpected callable: ${name}`)
      })
    }

    renderApp('/easy/goal')
    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(calls).toEqual([])
  })
})

/**
 * ステップ3（末尾）の並び替え。
 *
 * ⚠️ 「おすすめ」は軸として出さない（2026-08-28、利用者の指摘）。目的に合う
 * おすすめは画面のいちばん上に 3 件のカードとして常時出ているので、同じ並びを
 * 一覧側の選択肢にも置くと、押しても上と同じものが出てくるだけのボタンになる。
 */
describe('ステップ3の並び替え', () => {
  it('軸は価格・日本向け・企業向けの3つで、「おすすめ」は出さない', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')
    await walkToTld(user)

    const sort = await screen.findByRole('group', { name: '並び替え' })
    expect(within(sort).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '価格を重視',
      '日本向け',
      '企業向け',
    ])
    expect(within(sort).queryByRole('button', { name: 'おすすめ' })).toBeNull()
  })

  /* おすすめ帯は利用者が選んだ軸に影響されない。従わせると、上の3枚が
     「目的に合うおすすめ」を名乗ったまま中身だけ別物になる。 */
  it('並び替えを変えても、上のおすすめ3件は目的順のまま動かない', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')
    await walkToTld(user)

    const bandOf = () =>
      within(screen.getByRole('radiogroup'))
        .getAllByRole('radio')
        .slice(0, 3)
        .map((radio) => radio.getAttribute('value'))

    const before = bandOf()
    // business の目的なので .com が先頭（価格順なら .cyou / .icu / .xyz が来る）。
    expect(before[0]).toBe('.com')

    await user.click(within(screen.getByRole('group', { name: '並び替え' })).getByRole('button', { name: '価格を重視' }))
    expect(bandOf()).toEqual(before)
  })
})

describe('ステップの前提条件', () => {
  it('目的が未選択のまま /easy/tld を開くと最初のステップへ差し戻す', async () => {
    renderApp('/easy/tld')

    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')
  })

  it('目的を選ばずに「次へ」を押すとエラーを出して進まない', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('button', { name: /^次へ/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('用途を1つ選んでください。')
    expect(window.location.pathname).toBe('/easy/goal')
  })

  /**
   * ⚠️ `/easy` は「無言で続きへ飛ばす」場所ではない（issue #91）。前回の入力が
   * 残っていると 2/6 からいきなり始まり、しかも用途の自由入力に身に覚えのない
   * 文言が入っていて、初見の人には何が起きたのか説明が無かった。続きから進むか
   * 最初からやり直すかを、本人に選ばせる。
   */
  it('/easy は保存済みの続きがあると、再開かやり直しかを選ばせる', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /個人ブログ・ポートフォリオ/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })).toBeInTheDocument()

    cleanup()
    renderApp('/easy')
    expect(await screen.findByRole('heading', { name: ENTRY_HEADING })).toBeInTheDocument()
    // 何が引き継がれるのかを、選ぶ前に見せる。
    expect(screen.getByText('個人ブログ・ポートフォリオ')).toBeInTheDocument()
    /* ⚠️ 入口はステップではない。進捗を出すと、どのステップにも一致しない
       このパスが最後のステップに落ちて「6/6 つなぐ」を現在地として見せてしまう。 */
    expect(screen.queryByRole('navigation', { name: 'かんたんモードの進行状況' })).toBeNull()
  })

  it('「続きから進む」を押すと、保存済みの位置から再開する', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /個人ブログ・ポートフォリオ/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })).toBeInTheDocument()

    cleanup()
    renderApp('/easy')
    await user.click(await screen.findByRole('button', { name: ENTRY_RESUME_ACTION }))

    expect(await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/name')
  })

  it('「最初からやり直す」を押すと、保存を捨ててステップ1へ戻る', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /個人ブログ・ポートフォリオ/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    expect(await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })).toBeInTheDocument()

    cleanup()
    renderApp('/easy')
    await user.click(await screen.findByRole('button', { name: ENTRY_RESTART_ACTION }))

    expect(await screen.findByRole('heading', { name: GOAL_HEADING })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')
    // 保存そのものが消えているので、開き直しても選択画面は出ない。
    cleanup()
    renderApp('/easy')
    expect(await screen.findByRole('heading', { name: GOAL_HEADING })).toBeInTheDocument()
  })
})

describe('未ログインからの導線 (FIG.8)', () => {
  it('内容確認の手前でログイン画面へ送り、ログイン後に入力を保ったまま戻る', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)

    // 確認ステップは RequireAuth 配下。未ログインなので /login へ。
    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBe('/easy/confirm')

    // ログイン成立（AuthProvider が読む Cookie セッションを立てる）。
    sessionMock.authenticate()
    cleanup()
    renderApp('/easy/confirm')

    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()
    // ゲストのときの入力が uid スコープへ引き継がれている。
    expect(screen.getByText('my-bakery.com')).toBeInTheDocument()
  })

  it('末尾を選ぶ画面にログインフォームを出し、その場でログインすると内容確認へ進む', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToTld(user)

    // 「ログインが必要です」と言うだけでなく、入力欄そのものをこの画面に出す。
    expect(await screen.findByRole('heading', { name: 'ログインして続ける' })).toBeInTheDocument()
    expect(screen.getByText(LOGIN_REQUIRED_NOTICE)).toBeInTheDocument()

    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('id-token') },
    } as unknown as Awaited<ReturnType<typeof signInWithEmailAndPassword>>)

    await user.type(screen.getByLabelText('メールアドレス'), 'demo@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password123')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    // /login を経由せずに 4/6 へ。選んでいた末尾も uid スコープへ引き継がれる。
    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/confirm')
    expect(screen.getByText('my-bakery.com')).toBeInTheDocument()
  })
})

describe('取得から easyDNS 設定まで', () => {
  beforeEach(() => {
    sessionMock.authenticate()
  })

  it('確認 → 支払い → easyDNS → 完了 → マイページまで進める', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)

    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /お支払いに進む/ }))

    expect(await screen.findByRole('heading', { name: 'お支払い' })).toBeInTheDocument()
    await fillDummyPayment(user)
    await user.click(screen.getByRole('button', { name: '支払う（疑似決済）' }))

    // 支払い後は easyDNS 設定へ（注文の完了を待ってから設問が出る）。
    expect(await screen.findByRole('heading', { name: 'ドメインをつなぐ' })).toBeInTheDocument()

    // 使いみちは目的（ステップ1「会社やお店のWebサイト」）から決まっているので、
    // ここで聞かれるのはサービスだけ。答え済みの使いみちは読み上げられている。
    expect(await screen.findByText('Webサイトに接続する')).toBeInTheDocument()
    await user.click(await screen.findByRole('radio', { name: /Vercel/ }))
    await user.click(screen.getByRole('button', { name: 'この設定でつなぐ' }))

    // 保存しただけでは完了にしない。同じ画面の確認フェーズを挟む (§6.3.3d)。
    expect(await screen.findByText('つなぐ設定を保存しました')).toBeInTheDocument()

    // レシピのレコードが実際に保存されている。
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toEqual([
      { type: 'A', name: '@', value: '76.76.21.21' },
      { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' },
    ])

    await user.click(screen.getByRole('button', { name: '完了' }))
    expect(
      await screen.findByRole('heading', { name: 'つなぐ設定まで終わりました' }),
    ).toBeInTheDocument()
    // 完了画面は「これで見えるの？」に答える: いつ見えるか・待つのは正常・確かめかた。
    expect(screen.getByText('いつ見えるようになりますか？')).toBeInTheDocument()
    expect(screen.getByText(DONE_PROPAGATION_NOTE)).toBeInTheDocument()
    expect(screen.getByText('確かめかた')).toBeInTheDocument()

    /* 監査 2026-08-27: 「確認できます」と約束した画面の 2 番目のボタンが
       「自分で細かく設定する」を名乗っていた。つないだ人には確認の言葉で出し、
       手で直す導線はリンクへ落とす（行き先は同じ）。 */
    expect(screen.getByRole('link', { name: 'つながったか確認する' })).toHaveAttribute(
      'href',
      '/domains/my-bakery.com/dns',
    )
    expect(screen.getByRole('link', { name: '自分で細かく設定する（DNS設定）' })).toBeInTheDocument()

    // 完了はステップではない。ステッパーで「6/6 つなぐ設定」と名乗らない。
    expect(screen.queryByRole('navigation', { name: 'かんたんモードの進行状況' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'マイページへ移動する' }))
    expect(window.location.pathname).toBe('/mypage/domains/my-bakery.com')
    // 完了したので一時保存は破棄されている。
    expect(window.localStorage.getItem('registrar.easy.session.v1:u_demo')).toBeNull()
  })

  /**
   * 仕様 §1.2: かんたんモードは項目を「描画しない」だけで、送信するペイロードは
   * 通常モードと同じく常に完全でなければならない。
   */
  it('画面に出していない §6.2.6 の項目も、完全な値のまま送信する', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    await user.click(await screen.findByRole('button', { name: /お支払いに進む/ }))
    await fillDummyPayment(user)
    await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
    await screen.findByRole('heading', { name: 'ドメインをつなぐ' })

    const order = fakeBackend.orders().at(-1)
    expect(order?.domainName).toBe('my-bakery.com')
    expect(order?.years).toBe(ORDER_FORM_DEFAULTS.registrationYears)
    // 案A (spec v0.3.4): 注文はNSなしで作成し、NSは登録後の domain:update で
    // 付与する — デフォルトNS (defaultNameservers) は廃止された（orderDefaults.ts
    // の決定 2026-08-26）。空配列こそがこのモードの完全な値。
    expect(ORDER_FORM_DEFAULTS.nameserverMode).toBe('none')
    expect(order?.nameservers).toEqual([])
    expect(order?.authInfo.length).toBeGreaterThanOrEqual(20)
  })

  it('「あとで設定する」を選ぶとDNSを書かずに完了画面へ進む', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    await user.click(await screen.findByRole('button', { name: /お支払いに進む/ }))
    await fillDummyPayment(user)
    await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
    await screen.findByRole('heading', { name: 'ドメインをつなぐ' })

    // 「あとで設定する」は用途の選択肢ではなく、いつでも押せる離脱ボタン。
    await user.click(await screen.findByRole('button', { name: 'あとで設定する' }))

    // つなぐ設定をしていない人に「設定が完了しました」とは言わない。
    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    expect(screen.getByText(DONE_DNS_SKIPPED_NOTE)).toBeInTheDocument()
    // 「使いみち」を『あとで設定する』と読ませない（用途の答えではない）。
    expect(screen.getByText('まだ決めていません')).toBeInTheDocument()
    // 次に何をすればいいかを、バラの手順として渡す。
    expect(screen.getByText('このあとすること')).toBeInTheDocument()
    expect(screen.getByText('使いたいサービスに登録する（無料で試せるものもあります）')).toBeInTheDocument()
    // つないでいない人には確認するものが無いので、こちらは従来の言葉のまま。
    expect(screen.queryByRole('link', { name: 'つながったか確認する' })).toBeNull()
    expect(screen.getByRole('link', { name: '自分で細かく設定する（DNS設定）' })).toBeInTheDocument()
    // 完了画面はステッパーの外（DNSを飛ばした人に「6/6 つなぐ設定」と出さない）。
    expect(screen.queryByRole('navigation', { name: 'かんたんモードの進行状況' })).toBeNull()
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toBeUndefined()
  })

  /**
   * §6.3.3(d): 保存＝完了ではない。「つながったか確認する」手段を同じ画面に
   * 用意し、保存直後の状態を正常系として見せる（赤いエラーにしない）。
   * ⚠️ かんたんモードの注文はネームサーバーを付けない (§6.2.6) ので、着地は
   * 「未公開」であって「反映待ち」ではない。ここで ✓ を出すと、マイページの
   * 「まだインターネットに公開されていません」と真正面から矛盾する。
   */
  it('保存後は完了画面へ飛ばさず、確認パネルで「未公開」とNS設定への導線を見せる', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    // 使いみちは目的（ステップ1「会社やお店のWebサイト」）から決まっているので、
    // ここで聞かれるのはサービスだけ。答え済みの使いみちは読み上げられている。
    expect(await screen.findByText('Webサイトに接続する')).toBeInTheDocument()
    await user.click(await screen.findByRole('radio', { name: /Vercel/ }))
    await user.click(screen.getByRole('button', { name: 'この設定でつなぐ' }))

    expect(await screen.findByText('つなぐ設定を保存しました')).toBeInTheDocument()
    expect(screen.getByText('つながったか確認する')).toBeInTheDocument()

    // まだ完了画面へは進んでいない。
    expect(window.location.pathname).toBe('/easy/dns')
    expect(screen.queryByRole('heading', { name: '設定が完了しました' })).toBeNull()

    // 5状態のうち「未公開」。文言は DNS_CHECK_LABELS のものをそのまま使う。
    expect(screen.getAllByText('未公開').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('ネームサーバーが未設定のため、まだインターネットに公開されていません')
        .length,
    ).toBeGreaterThan(0)
    // 「つながっています ✓」は出さない（当サービスのDNSに入っただけなので）。
    expect(screen.queryByText('つながっています ✓')).toBeNull()
    expect(screen.queryByText('当サービスのDNSに登録されています ✓')).toBeNull()
    // 行き止まりにしない: 未公開の理由を直せる場所（NS変更）へ渡す。
    expect(screen.getByRole('link', { name: 'ネームサーバーを設定する' })).toHaveAttribute(
      'href',
      '/domains/my-bakery.com/dns?mode=ns',
    )
    // かんたんモードの見出しは生FQDNではなく平易な言い換え（variant="easy"）。
    expect(screen.getByText('別名の転送先（CNAMEレコード）')).toBeInTheDocument()

    /* 監査 2026-08-27: 確認パネルは押されるまで問い合わせないので、この
       「反映待ち」はまだ判定ですらない。押すべきボタンを名指しし、待ったまま
       完了してよいことも言う（言わないと、この画面から進めなくなる）。 */
    expect(screen.getByRole('button', { name: /すべて確認/ })).toBeInTheDocument()
    expect(screen.getByText(DNS_SAVED_WAIT_BODY)).toBeInTheDocument()
    expect(DNS_SAVED_WAIT_BODY).toContain('「すべて確認」')
    expect(screen.getByText(DNS_CHECK_DONE_NOTE)).toBeInTheDocument()
  })

  /**
   * §6.3.3(e): ネームサーバーごと預けるサービス（ns-guide）でレコードを保存すると、
   * 全置換セマンティクスにより「空で保存」になる。保存させないことが仕様。
   */
  it('ns-guide のサービスでは保存を行わず、NS変更の警告を出す', async () => {
    const saveCalls: unknown[] = []
    fakeBackend.on('saveDnsRecords', (data) => {
      saveCalls.push(data)
      return { records: [] }
    })

    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('radio', { name: /エックスサーバー/ }))

    expect(screen.getByText('このサービスは、つなぎ方が少し違います')).toBeInTheDocument()
    expect(
      screen.getByText(
        'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。',
      ),
    ).toBeInTheDocument()

    // 保存ボタンそのものを出さない（押せる形にしない）。
    expect(screen.queryByRole('button', { name: 'この設定でつなぐ' })).toBeNull()
    expect(saveCalls).toEqual([])
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toBeUndefined()

    expect(screen.getByRole('link', { name: /ネームサーバーの変更に進む/ })).toHaveAttribute(
      'href',
      '/domains/my-bakery.com/dns?mode=ns',
    )
  })

  /** §6.3.3(c): 一覧にないサービスでも袋小路にしない（貼り付けパーサへ逃がす）。 */
  it('貼り付けパーサで読み取ったレコードがそのまま保存対象になる', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('radio', { name: /一覧にない/ }))

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByLabelText('設定案内のテキスト'))
    await user.paste('Type: CNAME\nName: www\nValue: cname.example.net')
    await user.click(within(dialog).getByRole('button', { name: '読み取る' }))
    await user.click(within(dialog).getByRole('button', { name: 'レコード案に追加' }))

    expect(
      await screen.findByText('案内文から読み取った設定です。この内容で保存します。'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'この設定でつなぐ' }))

    expect(await screen.findByText('つなぐ設定を保存しました')).toBeInTheDocument()
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toEqual([
      { type: 'CNAME', name: 'www', value: 'cname.example.net' },
    ])
  })

  /**
   * つなぎ先（サイトやメールの置き場所）をまだ持っていない人の経路。
   * ⚠️ レコードは 1 件も無いので、この選択のあいだは保存させない
   * （空配列の保存は全置換で「全部消す」保存になる — §6.3.3e と同じ理由）。
   */
  it('つなぎ先が無い人には用意する手順を出し、保存はしない', async () => {
    const saveCalls: unknown[] = []
    fakeBackend.on('saveDnsRecords', (data) => {
      saveCalls.push(data)
      return { records: [] }
    })

    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('radio', { name: /まだ用意していない/ }))

    // 何を用意するのか・具体例・順番・いま決めなくていい理由の 4 点を出す。
    expect(screen.getByText('つなぐ先を用意するところから始めましょう')).toBeInTheDocument()
    expect(screen.getByText(DNS_NO_TARGET_BODY)).toBeInTheDocument()
    expect(screen.getByText(DNS_NO_TARGET_WEB_EXAMPLES)).toBeInTheDocument()
    expect(screen.getByText(DNS_NO_TARGET_MAIL_EXAMPLES)).toBeInTheDocument()
    expect(screen.getByText('そのサービスから「独自ドメインの設定方法」の案内が届く')).toBeInTheDocument()
    expect(screen.getByText(DNS_NO_TARGET_SAFE_NOTE)).toBeInTheDocument()

    // 保存ボタンそのものを出さない（押せる形にしない）。
    expect(screen.queryByRole('button', { name: 'この設定でつなぐ' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'あとで設定する' }))

    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    expect(saveCalls).toEqual([])
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toBeUndefined()
  })

  /**
   * 監査 2026-08-27: 「この設定でつなぐ」の手前に、何が起きるかがどこにも
   * 書かれていなかった。レコードの表は「詳細を見る」の中だけにあり、入力欄を
   * 持たないサービス（Vercel）ではラジオの点以外に画面が何も変わらないまま
   * 確定させていた。文はレシピ固有の固定文ではなく、実際に保存するレコードから
   * 組み立てる（サービスを変えれば文も変わることまで検証する）。
   */
  it('確定ボタンの手前に、保存するレコードから作った「何が起きるか」を必ず出す', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('radio', { name: /Vercel/ }))

    // 「詳細を見る」は畳んだまま（A/CNAME は出ていない）でも、結果は読める。
    expect(screen.queryByText('別名の転送先（CNAMEレコード）')).toBeNull()
    expect(screen.getByText('この設定でつなぐと、こうなります')).toBeInTheDocument()
    expect(
      screen.getByText('my-bakery.com と www.my-bakery.com を Vercel に向けます。'),
    ).toBeInTheDocument()
    expect(screen.getByText('ほかに変わるものはありません。')).toBeInTheDocument()

    // サービスを変えれば文も変わる（固定文を書いていない証拠）。入力が埋まるまでは
    // 保存するレコードが確定しないので、この行自体を出さない。
    await user.click(await screen.findByRole('radio', { name: /独自サーバー/ }))
    expect(screen.queryByText('この設定でつなぐと、こうなります')).toBeNull()

    await user.type(screen.getByLabelText('サーバのIPアドレス'), '203.0.113.10')
    expect(
      await screen.findByText('my-bakery.com と www.my-bakery.com を 独自サーバー に向けます。'),
    ).toBeInTheDocument()
  })

  /** メールのレコード（MX）を書くときは「向ける」ではなく「届ける」で言う。 */
  it('メールのサービスでは、届け先としての結果を出す', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('button', { name: '使いみちを変える' }))
    await user.click(await screen.findByRole('radio', { name: /メールに使用する/ }))
    await user.click(await screen.findByRole('radio', { name: /Google Workspace/ }))

    expect(
      await screen.findByText('my-bakery.com 宛のメールを Google Workspace に届けます。'),
    ).toBeInTheDocument()
  })

  /**
   * 監査 2026-08-27: ns-guide を選ぶと、赤い警告と NS 変更画面（通常モード）への
   * リンクだけが出ていた。取得直後のドメインには消えるレコードもメールも無いので
   * この警告はこの場面では事実に反し、しかも出口が 1 本しかないためウィザードは
   * 6/6 で捨てられ、ステップ7に誰も到達しなかった。
   * ⚠️ NS_CHANGE_WARNING 本文（通常モードと共有）は書き換えず、添えるだけ。
   */
  it('ns-guide の警告を赤にせず事実を添え、「あとで設定する」で完了画面へ抜けられる', async () => {
    const saveCalls: unknown[] = []
    fakeBackend.on('saveDnsRecords', (data) => {
      saveCalls.push(data)
      return { records: [] }
    })

    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToDns(user)

    await user.click(await screen.findByRole('radio', { name: /Cloudflare/ }))

    // 通常モードと共有の警告文はそのまま出す（弱めない）。
    const warning = screen.getByText(
      'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。',
    )
    expect(warning).toBeInTheDocument()
    // ただしこの場面では「これから壊れる」話ではないので、赤いエラーにしない。
    expect(warning.closest('[role="alert"]')).toBeNull()
    expect(warning.closest('[role="status"]')).not.toBeNull()
    expect(
      screen.getByText(DNS_NS_GUIDE_FRESH_NOTE),
    ).toBeInTheDocument()

    // 出口は NS 変更だけではない。戻ってこられることも言う。
    expect(screen.getByRole('link', { name: /ネームサーバーの変更に進む/ })).toBeInTheDocument()
    expect(screen.getByText(DNS_NS_GUIDE_LATER_NOTE)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'あとで設定する' }))

    // ウィザードを 6/6 で捨てさせない。ステップ7まで到達する。
    expect(await screen.findByRole('heading', { name: 'ドメインを取得しました' })).toBeInTheDocument()
    // ⚠️ ns-guide ではレコードを 1 件も書かない（空配列の保存＝全消し）。
    expect(saveCalls).toEqual([])
    expect(fakeBackend.dnsRecords()['my-bakery.com']).toBeUndefined()
  })

  /**
   * 監査 2026-08-27: 支払い画面が通常モードの PriceDisplay をそのまま使っていたため、
   * 請求額（1年分）のすぐ下に「3年間の合計」がより太く出ていた。この画面に出して
   * よい合計は、いま引き落とされる額だけである。
   */
  it('支払い画面は請求額以外の合計を出さず、来年以降の自動課金を金額つきで明言する', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    await user.click(await screen.findByRole('button', { name: /お支払いに進む/ }))
    expect(await screen.findByRole('heading', { name: 'お支払い' })).toBeInTheDocument()

    /* いま請求されるのは .com の初年度 1 年分だけ、と言い切る。請求額の帯は
       確認画面とまったく同じ形（見出し＋金額）なので、見出しの文も共有の
       paymentChargedLabel を使う。 */
    expect(screen.getAllByText('¥1,480').length).toBeGreaterThan(0)
    const paidBand = screen.getByText(paymentChargedLabel(1))
    expect(paidBand.tagName).not.toBe('DT')
    expect(paidBand.parentElement).toHaveTextContent('¥1,480')

    // 請求額以外の合計は 1 つも出さない。
    expect(screen.queryByText(/3年間の合計/)).toBeNull()

    // §6.2.5 の参照ペアは残す（同じ文字サイズで並記）。
    const firstYear = screen.getByText('初年度')
    const renewal = screen.getByText('2年目以降 毎年')
    expect(firstYear).toBeInTheDocument()
    expect(renewal).toBeInTheDocument()

    // 継続課金への同意はこの画面でしか取れない。金額と止め方を書く。
    expect(screen.getByText('来年以降')).toBeInTheDocument()
    expect(screen.getByText(autoRenewOnNote('¥1,980'))).toBeInTheDocument()
    // 金額と止め方の両方が要る。片方だけだと同意として成立しない。
    expect(autoRenewOnNote('¥1,980')).toContain('¥1,980')
    expect(autoRenewOnNote('¥1,980')).toContain('OFF')

    // 自動更新 ON と「これが最後の支払い操作です」は両立しない。
    expect(screen.queryByText(/これが最後の支払い操作です/)).toBeNull()
    expect(screen.getByText(PAYMENT_LEDE)).toBeInTheDocument()
    expect(PAYMENT_LEDE).toContain('確定します')
  })

  /**
   * 監査 2026-08-27: 確認画面は「初年度料金」と「今回のお支払い」を同じ表に並べ、
   * 既定の 1年 では同額の 2 行になっていた。請求額は表の外で 1 回だけ強調する。
   */
  it('確認画面は請求額を表の外で1回だけ出し、自動更新ONに金額を添える', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()

    // 請求額の見出しは表の行（dt）ではない ＝ 参照用の料金表と取り違えられない。
    const chargedLabel = screen.getByText('今回のお支払い（1年分）')
    expect(chargedLabel.tagName).not.toBe('DT')

    // 参照ペアは表に残す（§6.2.5）。
    expect(screen.getByText('初年度料金')).toBeInTheDocument()
    expect(screen.getByText('2年目以降 毎年')).toBeInTheDocument()

    // 自動更新 ON は無料で続くという意味ではない。金額を必ず添える。
    expect(screen.getByText(autoRenewOnSummary('¥1,980'))).toBeInTheDocument()
    // 金額の無い ON 表示は「もう請求されない」と読まれる。必ず金額を含める。
    expect(autoRenewOnSummary('¥1,980')).toContain('¥1,980')
    expect(AUTO_RENEW_OFF_SUMMARY).not.toContain('¥')
  })

  /**
   * 確認画面の「変更」は、直したい 1 項目のためだけの寄り道でなければならない。
   * 修正後にウィザードを最後まで歩き直させると、確認画面まで戻るのに 3 画面かかる。
   * 使いみちは名前や末尾の空き状況に影響しないので、直したらその場で確認画面へ返す。
   */
  it('確認画面の「使いみちを変更」から目的を選び直すと、名前・末尾を通らずに確認画面へ戻る', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '使いみちを変更' }))

    // 目的の画面に、戻り先の文脈（?return=confirm）を持って着く。
    expect(await screen.findByRole('heading', { name: '何に使いますか？' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/goal')
    expect(window.location.search).toBe('?return=confirm')

    await user.click(await screen.findByRole('radio', { name: /個人ブログ・ポートフォリオ/ }))
    // 主要ボタンは「次へ」ではなく、行き先を名乗る（まだ先があると読ませない）。
    await user.click(screen.getByRole('button', { name: /確認画面に戻る/ }))

    // 名前（2/6）・末尾（3/6）を経由せず、そのまま確認画面へ。
    expect(await screen.findByRole('heading', { name: '内容の確認' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/confirm')
    // 選び直した使いみちが確認画面に反映されている。
    expect(screen.getByText('個人ブログ・ポートフォリオ')).toBeInTheDocument()
    // 名前と末尾は触っていないので、そのまま残っている。
    expect(screen.getByText('my-bakery.com')).toBeInTheDocument()
  })

  it('注文済みのセッションで手前のステップへ戻ろうとしても再注文させない', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await walkToConfirm(user)
    await user.click(await screen.findByRole('button', { name: /お支払いに進む/ }))
    await fillDummyPayment(user)
    await user.click(await screen.findByRole('button', { name: '支払う（疑似決済）' }))
    await screen.findByRole('heading', { name: 'ドメインをつなぐ' })

    cleanup()
    renderApp('/easy/payment')

    expect(await screen.findByRole('heading', { name: 'ドメインをつなぐ' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/dns')
    expect(fakeBackend.orders()).toHaveLength(1)
  })
})

describe('確認できなかったときの表示 (§6.7)', () => {
  it('レジストリが答えなかった末尾を「取得済み」と偽らない', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('partial-registry-timeout')
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))

    const input = await screen.findByLabelText('使いたい名前')
    await user.type(input, 'my-bakery')
    await user.click(screen.getByRole('button', { name: NAME_SEARCH_ACTION }))

    await user.click(await screen.findByRole('radio', { name: /^my-bakery[^a-z0-9-]/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))

    // kitaqnic 側は無応答。おすすめ3件には入れず、「いま選べない末尾」の帯に
    // 「？ 確認できませんでした」で出る。✕（取得済み）には決してしない。
    // （2026-08-27: 一覧を畳むのをやめたので「ほかの候補を見る」を開く操作は無い。
    //  出し分けの検証対象は、おすすめ帯に混ざっていないことと読み上げ名のほう。）
    // 「いま選んでいるドメイン」の行と .com のおすすめカードの2か所に出るので
    // findAllByText。ここは待ち合わせであって、件数の検証ではない。
    expect(await screen.findAllByText('my-bakery.com')).not.toHaveLength(0)

    const unknown = await screen.findByRole('radio', { name: /my-bakery\.xyz/ })
    expect(unknown).toHaveAccessibleName(/確認できませんでした/)
    expect(unknown).not.toHaveAccessibleName(/取得済み/)
    expect(unknown).toBeDisabled()

    // おすすめ帯に無応答の末尾が紛れ込んでいないこと。kitaqnic が無応答だと
    // 答えられるのは kitaqsign の .com / .net だけ（2026-08-27 の移管で
    // .org / .info は kitaqnic 管轄）なので、3枠を埋めずに2件で止まるのが正:
    // 件数を偽装して「？」の末尾を混ぜてはいけない。
    const recommended = within(
      screen.getByRole('heading', { name: /目的に合うおすすめ/ }).parentElement as HTMLElement,
    ).getAllByRole('radio')
    expect(recommended).toHaveLength(2)
    for (const radio of recommended) {
      expect(radio).toHaveAccessibleName(/取得できます/)
    }
  })
})

/**
 * ステップ1〜2 の「言わないと詰まる」もの。
 * どれも「押したのに何も起きない」「全部ダメだと誤解する」で初心者が止まる箇所。
 */
describe('ステップ1〜2の伝えかた', () => {
  it('検索すると検索結果の画面へ移り、候補はそこに出る', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))

    // 検索の画面は入力欄までしか持たない（押す前に候補が生えていない）。
    await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

    await user.type(await screen.findByLabelText('使いたい名前'), 'my-bakery')
    await user.click(screen.getByRole('button', { name: NAME_SEARCH_ACTION }))

    // 候補は別画面（＝押した手応えが画面の切り替わりとして出る）。
    expect(await screen.findByRole('heading', { name: NAME_RESULTS_HEADING })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/name/results')
    expect(await screen.findByRole('radio', { name: /^my-bakery[^a-z0-9-]/ })).toBeChecked()

    // 「戻る」は検索の画面へ返す（結果の画面で行き止まりにしない）。
    // ⚠️ `main` に絞る — ヘッダーにも「通常モードに戻る」が常時出ている（issue #91）。
    await user.click(within(screen.getByRole('main')).getByRole('link', { name: /戻る/ }))
    expect(await screen.findByRole('heading', { name: 'ドメイン名を決めましょう' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/easy/name')
  })

  it('空き確認が終わるまでは「確認できませんでした」と偽らない', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fakeBackend.on('searchDomains', async (data) => {
      await gate
      const { names } = data as { names: string[] }
      return {
        results: names.map((name) => ({
          name: name.toLowerCase(),
          registry: 'kitaqsign' as const,
          available: true,
        })),
        unsupported: [],
        unavailable: [],
        maintenance: [],
      }
    })

    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    await user.type(await screen.findByLabelText('使いたい名前'), 'my-bakery')
    await user.click(screen.getByRole('button', { name: NAME_SEARCH_ACTION }))

    // 確認の返事を待っている間は「確認中…」。？（確認できませんでした）にはしない。
    const pending = await screen.findByRole('radio', { name: /^my-bakery[^a-z0-9-]/ })
    expect(pending).toHaveAccessibleName(/確認中…/)
    expect(pending).not.toHaveAccessibleName(/確認できませんでした/)
    // まだ確認していないだけなので、選べなくはしない。
    expect(pending).toBeEnabled()

    release()
    await vi.waitFor(() =>
      expect(screen.getByRole('radio', { name: /^my-bakery[^a-z0-9-]/ })).toHaveAccessibleName(
        /取得できます/,
      ),
    )
  })

  it('候補がすべて取得済みなら、押せない「次へ」の代わりに理由と次の一手を出す', async () => {
    fakeBackend.setSearchMode('all-taken')
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))
    await user.type(await screen.findByLabelText('使いたい名前'), 'my-bakery')
    await user.click(screen.getByRole('button', { name: NAME_SEARCH_ACTION }))

    expect(
      await screen.findByText(
        'この名前は、どの末尾でも取得できませんでした。上の入力欄で別の名前を入れて、もう一度おためしください。',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^次へ/ })).toBeDisabled()
    expect(window.location.pathname).toBe('/easy/name/results')
  })

  it('目的を選ばずに「次へ」を押したとき、出したエラーまで画面を運ぶ', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    })
    try {
      const user = userEvent.setup()
      renderApp('/easy/goal')

      await user.click(await screen.findByRole('button', { name: /^次へ/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('用途を1つ選んでください。')
      // バナーは選択肢の上、ボタンは最下部。モバイルで「何も起きない」に見せない。
      await vi.waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }),
      )
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('1枚目は選択肢だけを見せる（読ませる文を足さない）', async () => {
    renderApp('/easy/goal')

    // 選択肢は名前だけでなく、何を選ぼうとしているのかも 1 行で見せる。
    expect(await screen.findByText('会社案内やお店の紹介ページ')).toBeInTheDocument()
    // 畳んだ側に何が入っているかを、開く前に言う。
    expect(screen.getByRole('button', { name: GOAL_MORE_ACTION })).toBeInTheDocument()
    // 開く価値を判断できるよう、畳んだ側の例をラベルに残す。
    expect(GOAL_MORE_ACTION).toContain('メール')
  })

  it('ドメイン名の画面で、専門用語（ラベル）を消さずに併記する', async () => {
    const user = userEvent.setup()
    renderApp('/easy/goal')

    await user.click(await screen.findByRole('radio', { name: /会社やお店のWebサイト/ }))
    await user.click(screen.getByRole('button', { name: /^次へ/ }))

    expect(await screen.findByText(NAME_JARGON_NOTE)).toBeInTheDocument()
    // §1.4: 平易な言い換えのあとに、用語そのものも 1 度は渡す。
    expect(NAME_JARGON_NOTE).toContain('ラベル')
  })
})
