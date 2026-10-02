/**
 * Integration tests for the「ドメインをつなぐ」screen (docs/api-flow-diagrams.html
 * FIG.11, spec §6.3): the goal-first entry (何に使いますか？ → 案内の見分け →
 * §6.3.3(a) の分岐), the third path for people who have nothing prepared yet,
 * the guided record editor (入力の準備 → 内容を入力 → 確認 → つながる) with its
 * three input paths (manual row / template / paste), full-replacement save behind
 * the pre-save confirmation step, the §6.3.3(d) four-state confirm button, and the
 * NS change mode reusing the real updateDomain wire. Same harness as
 * mypageFlow.test.tsx: real router, fakeBackend at the invoke() seam, auth
 * session on MSW.
 *
 * ⚠️ The spec wording of §6.3.3(a) must stay reachable (§1.4 — terms are kept,
 * not erased), but it must NOT be on the default reading path. Both halves of
 * that are asserted below; do not drop either one.
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
 * `mocks/handlers.ts`'s `authenticate()` still expects for domains calls once
 * `AuthProvider` writes `SESSION_TOKEN_SENTINEL` - see its doc comment.
 */
function loginAsDemoUser() {
  sessionMock.authenticate()
}

/** 入口は目的から。案内の見分けは、使いみちを答えたあとの2画面目にある。 */
async function openEvidenceStep(path = '/domains/teamc-demo.com/dns') {
  loginAsDemoUser()
  renderApp(path)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'ホームページを見せたい' }))
  return user
}

async function openRecordMode(path = '/domains/teamc-demo.com/dns') {
  const user = await openEvidenceStep(path)
  await user.click(await screen.findByRole('button', { name: /数字のIPアドレスや、案内先のホスト名が書いてある/ }))
  return user
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

describe('FIG.11 入口 — 目的から入る', () => {
  it('opens on what the user wants, gives the mental model once, and shows the inactive notice for NS-less domains', async () => {
    loginAsDemoUser()
    renderApp('/domains/teamc-easy.net/dns')

    // 画面の入口は「何を渡されたか」ではなく「何がしたいか」。
    expect(await screen.findByText('このドメインを、何に使いますか？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ホームページを見せたい' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'メールで使いたい' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'まだ何も用意していない／何をすればいいか分からない' }),
    ).toBeInTheDocument()

    // 仕組みの説明は1度だけ、専門用語なしで。図の意味は文字でも持たせる。
    expect(screen.getByText('いまは、名前と中身がつながっていません')).toBeInTheDocument()
    expect(
      screen.getByText(
        'teamc-easy.net は、インターネット上の住所です。ホームページの中身やメールは、それとは別の会社のコンピュータに置かれています。いまはその2つが結びついていないので、teamc-easy.net と打っても何も出てきません。この画面ですることは、住所と置き場所を結びつける「転送届」を1回出すことだけです。',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('ドメイン名 →（この画面でつなぐ）→ ホームページやメールのある場所'),
    ).toBeInTheDocument()

    // §3.5: inactive = NS未設定はスペック文言のバナーで伝える。
    expect(
      screen.getByText(
        'まだインターネットに公開されていません。ネームサーバー（DNS）の設定をすると使い始められます。',
      ),
    ).toBeInTheDocument()
  })

  it('keeps DNS vocabulary off the default reading path of the entry screen', async () => {
    loginAsDemoUser()
    renderApp('/domains/teamc-demo.com/dns')
    await screen.findByText('このドメインを、何に使いますか？')

    // 用語は消していないが、最初の画面で読ませることはしない（§1.4 は併記であって、
    // 主動線に置くことではない）。
    expect(
      screen.queryByText(
        '契約したサービスから「ネームサーバー（ns1.〜 のような文字列）」を渡されましたか？',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'DNSの設定には「①どのDNSに任せるか（ネームサーバー）」と「②そこに何を書くか（レコード）」の2段階があります。いま設定するのは、そのうちの片方だけです。',
      ),
    ).not.toBeInTheDocument()
  })

  it('gives someone with nothing prepared a real path: what to sign up for, and that leaving is safe', async () => {
    loginAsDemoUser()
    renderApp('/domains/teamc-demo.com/dns')
    const user = userEvent.setup()

    await user.click(
      await screen.findByRole('button', { name: 'まだ何も用意していない／何をすればいいか分からない' }),
    )

    expect(await screen.findByText('先に、中身を置く場所を用意します')).toBeInTheDocument()
    expect(
      screen.getByText(
        'ドメインは住所です。住所だけでは、まだ見せるものがありません。ホームページなら中身を置くサービス、メールならメールのサービスを、先に1つ決めてください。',
      ),
    ).toBeInTheDocument()
    // 実名のサービスを挙げないと「何に登録すればいいか」は伝わらない。
    expect(screen.getByText('Wix / STUDIO / ペライチ')).toBeInTheDocument()
    expect(screen.getByText('Google Workspace')).toBeInTheDocument()
    // 登録 → 案内が届く → ここへ戻る、という順番を明示する。
    expect(
      screen.getByText(
        '「次の内容を設定してください」という案内が表示されます。それを持って、この画面に戻ってきてください。',
      ),
    ).toBeInTheDocument()
    // 何もしないまま離れても安全であることを言い切る。
    expect(screen.getByText('いま設定しなくても大丈夫です')).toBeInTheDocument()
    expect(
      screen.getByText(
        'このまま何も設定せずに閉じても、ドメインはあなたのものとして登録されたままです。なくなったり、他の人に取られたりすることはありません。準備ができてから、いつでもこの画面を開き直せます。',
      ),
    ).toBeInTheDocument()
    // 行き止まりにしない — 出口が2つある。
    expect(screen.getByRole('link', { name: 'ドメインの画面に戻る' })).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: '案内はもう手元にある — 使いみちを選んで始める' }),
    )
    expect(await screen.findByText('このドメインを、何に使いますか？')).toBeInTheDocument()
  })
})

describe('FIG.11 モード分岐 (§6.3.3a)', () => {
  it('asks the evidence question after the goal, and keeps the spec wording behind the disclosure', async () => {
    const user = await openEvidenceStep()

    // 案内を開くという動作から始める（用語の問いからではない）。
    expect(await screen.findByText('使うサービスから届いた案内を、手元に開いてください')).toBeInTheDocument()
    expect(screen.getByText('案内に書いてあるのは、どちらですか？')).toBeInTheDocument()
    expect(
      screen.getByText('入力は3分ほどで終わります（設定が世界中に行き渡るのを待つ時間は別です）'),
    ).toBeInTheDocument()
    // 答え済みの使いみちは読み上げ、選び直せるようにする。
    expect(screen.getByText('使いみち: ホームページを見せたい')).toBeInTheDocument()

    // §6.3.3(a) の1問と2階層の説明は、開閉部の中に原文のまま残っている。
    expect(
      screen.queryByText(
        '契約したサービスから「ネームサーバー（ns1.〜 のような文字列）」を渡されましたか？',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('当サービスのDNSにレコード（A・CNAME・MXなど）を設定します。'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'くわしく知りたい方へ（専門用語での説明）' }))
    expect(
      screen.getByText(
        '契約したサービスから「ネームサーバー（ns1.〜 のような文字列）」を渡されましたか？',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'ネームサーバーの差し替え（委任先の変更）を行います。以降のレコード設定は不要です。',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('当サービスのDNSにレコード（A・CNAME・MXなど）を設定します。'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'DNSの設定には「①どのDNSに任せるか（ネームサーバー）」と「②そこに何を書くか（レコード）」の2段階があります。いま設定するのは、そのうちの片方だけです。',
      ),
    ).toBeInTheDocument()
  })

  it('makes 「分からない」 a third option that starts the reversible (records) side', async () => {
    const user = await openEvidenceStep()

    await user.click(await screen.findByRole('button', { name: '案内が見当たらない・どちらか分からない' }))
    expect(
      screen.getByText(
        '契約したサービスから届いた案内を見てください。「ns1.〜」のような文字列が2つ書いてあれば「はい」、203.0.113.10 のような数字や ◯◯.example.com のような案内先が書いてあれば「いいえ」です。',
      ),
    ).toBeInTheDocument()
    // 迷った人にNS変更を勧めない（§6.3.3e: メールが止まる）。
    expect(
      screen.getByText(
        'レコードの設定は、あとから何度でもやり直せます。もう一方のネームサーバー変更は、メールが止まることがあるので、確信があるときだけ選んでください。',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '分からないまま、レコードの設定から始める' }))
    expect(
      await screen.findByText('いましているのは、このドメインのつなぎ先を書き込むことです'),
    ).toBeInTheDocument()
    expect(screen.getByText('渡された案内を、どうやって入力しますか？')).toBeInTheDocument()
  })

  it('names what the user is doing in plain words, and keeps the two-layer wording in the disclosure', async () => {
    const user = await openEvidenceStep()

    await user.click(await screen.findByRole('button', { name: /「ns1.〜」のような文字列が2つ書いてある/ }))

    expect(
      await screen.findByText('いましているのは、このドメインの案内役をそのサービスに引き渡すことです'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '渡された文字列を保存すると、以降このドメインの案内はそのサービスが受け持ちます。ホームページもメールも、設定はそちらの画面で行うことになります。',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'DNS設定の進行状況' })).toBeInTheDocument()
    expect(screen.getByText('内容を入力')).toBeInTheDocument()

    // 仕様の2階層の名づけは消さず、開けば読める（§1.4）。
    expect(
      screen.queryByText('いま設定しているのは ①どのDNSに任せるか（ネームサーバー）です'),
    ).not.toBeInTheDocument()
    const disclosures = screen.getAllByRole('button', { name: 'くわしく知りたい方へ（専門用語での説明）' })
    await user.click(disclosures[0])
    expect(
      screen.getByText('いま設定しているのは ①どのDNSに任せるか（ネームサーバー）です'),
    ).toBeInTheDocument()
  })

  it('NS mode shows the spec-mandated warning and updates nameservers via the real updateDomain wire', async () => {
    const user = await openEvidenceStep()

    await user.click(await screen.findByRole('button', { name: /「ns1.〜」のような文字列が2つ書いてある/ }))

    expect(
      await screen.findByText(
        'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。',
      ),
    ).toBeInTheDocument()

    const first = screen.getByLabelText('ネームサーバー1')
    const second = screen.getByLabelText('ネームサーバー2')
    await user.clear(first)
    await user.type(first, 'ns1.newdns.example')
    await user.clear(second)
    await user.type(second, 'ns2.newdns.example')
    await user.click(screen.getByRole('button', { name: '変更を保存する' }))

    expect(
      await screen.findByText('ネームサーバーを変更しました。反映まで時間がかかる場合があります。'),
    ).toBeInTheDocument()
    const domain = fakeBackend.domains().find((entry) => entry.name === 'teamc-demo.com')
    expect(domain?.nameservers).toEqual(['ns1.newdns.example', 'ns2.newdns.example'])
  })
})

describe('FIG.11 レコード設定モード', () => {
  it('adds a manual row, saves the full set, and the stub store reflects it', async () => {
    const user = await openRecordMode()

    // 未保存のうちは確認パネルが「未設定」(§6.3.3d)。
    expect(await screen.findByText('未設定')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '76.76.21.21')
    // 保存の前に必ず確認ステップを通る。
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))
    expect(await screen.findByText('この内容で保存します')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存する' }))

    expect(
      await screen.findByText(
        'つなぎ先を保存しました。下の「確認する」で、実際につながったかを確かめられます。',
      ),
    ).toBeInTheDocument()
    // 空の名前は '@'（ルート）へ正規化されて全置換保存される。
    expect(fakeBackend.dnsRecords()['teamc-demo.com']).toEqual([
      { type: 'A', name: '@', value: '76.76.21.21' },
    ])
  })

  it('reports the saved state in the user own terms, not as a record count', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '76.76.21.21')
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))
    await user.click(await screen.findByRole('button', { name: '保存する' }))

    // 「1件のレコードが登録されています」では、足りているのかが分からない。
    expect(
      await screen.findByText(
        'teamc-demo.com を開いた人に、指定した場所のホームページを表示する設定になっています。',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('登録されている設定: 1件')).toBeInTheDocument()
    // 確認パネルが答えるのは「つながりましたか？」。説明にリゾルバは出さない。
    // ⚠️ ただし「インターネット側から見えるか」を名乗ってはならない (§6.3.1)。
    expect(screen.getByText('つながったか確認する')).toBeInTheDocument()
    expect(
      screen.getByText('保存した内容が、当サービスのDNSに正しく登録されているかを調べます。'),
    ).toBeInTheDocument()
  })

  it('confirm button reports 確認できた for a saved record and 反映待ち on an empty resolver answer (§6.3.3d)', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '76.76.21.21')
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))
    await user.click(await screen.findByRole('button', { name: '保存する' }))
    await screen.findByText('つなぎ先を保存しました。下の「確認する」で、実際につながったかを確かめられます。')

    // fakeBackend の resolveDns は保存済みレコードを返す → 一致 = 確認できた。
    // ⚠️ 確認できたのは「当サービスのDNSへの登録」まで。teamc-demo.com は外部の
    //    ネームサーバーに委任済みなので、公開に使われるのはそちらだと明示する。
    await user.click(screen.getByRole('button', { name: '確認する' }))
    expect(await screen.findByText('確認できた')).toBeInTheDocument()
    expect(screen.getByText('当サービスのDNSに登録されています ✓')).toBeInTheDocument()
    expect(screen.queryByText('つながっています ✓')).toBeNull()
    expect(
      screen.getByText(
        'このドメインは外部のネームサーバーに任されているため、ここで保存した内容は公開には使われません。実際に見えている内容は、任せた先のサービスの設定で決まります。',
      ),
    ).toBeInTheDocument()

    // 保存済みだが引けない（反映前）→ エラーではなく「反映待ち」(2値にしない)。
    fakeBackend.on('resolveDns', () => ({ records: [] }))
    await user.click(screen.getByRole('button', { name: '確認する' }))
    expect(await screen.findByText('反映待ち')).toBeInTheDocument()
    expect(
      screen.getByText('設定は保存されました。反映まで通常数分〜最大48時間かかります'),
    ).toBeInTheDocument()
  })

  /**
   * 回帰 (2026-08-28): NS未委任 (§3.5 `inactive`) のドメインで「確認する」が
   * ✓ を出していた。resolveDns は保存先の Firestore を引き直しているだけなので
   * 保存が成功していれば必ず一致する — マイページが「まだインターネットに公開
   * されていません」と言っている横で ✓ が出る、という矛盾になっていた。
   */
  it('未委任のドメインでは ✓ を出さず、未公開であることとNS設定への導線を出す (§6.3.3d)', async () => {
    const user = await openRecordMode('/domains/teamc-easy.net/dns')

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '76.76.21.21')
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))
    await user.click(await screen.findByRole('button', { name: '保存する' }))

    // 押す前から答えは決まっている（応答に依らない判定）ので、先に見せる。
    expect(await screen.findByText('未公開')).toBeInTheDocument()
    expect(
      screen.getByText('ネームサーバーが未設定のため、まだインターネットに公開されていません'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'このドメインはまだインターネットに公開されていません（取得した直後はこの状態です）。ここで保存した内容は、ネームサーバーを設定するまで誰にも届きません。',
      ),
    ).toBeInTheDocument()
    // 行き止まりにしない: 直し方（NS変更モード）へ進めること。
    expect(screen.getByRole('link', { name: 'ネームサーバーを設定する' })).toHaveAttribute(
      'href',
      '/domains/teamc-easy.net/dns?mode=ns',
    )

    // 保存内容は当サービスのDNSに入っているが、それは ✓ の理由にならない。
    await user.click(screen.getByRole('button', { name: '確認する' }))
    expect(await screen.findByText('未公開')).toBeInTheDocument()
    expect(screen.queryByText('確認できた')).toBeNull()
    expect(screen.queryByText('当サービスのDNSに登録されています ✓')).toBeNull()
  })

  it('applies the Vercel recipe into the editor table (§6.3.3b)', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: 'テンプレートから選ぶ' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /Vercel/ }))
    await user.click(within(dialog).getByRole('button', { name: 'レコード案に追加' }))

    expect(screen.getByDisplayValue('76.76.21.21')).toBeInTheDocument()
    expect(screen.getByDisplayValue('cname.vercel-dns.com')).toBeInTheDocument()
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
  })

  it('ns-guide recipes (Cloudflare) route to the NS change mode instead of records', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: 'テンプレートから選ぶ' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /Cloudflare/ }))
    expect(
      within(dialog).getByText('このサービスはネームサーバー変更で設定します'),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'NS変更モードへ' }))

    // §6.3.3(e) の警告が出ていれば NS変更モードに切り替わっている。
    expect(
      await screen.findByText(
        'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。',
      ),
    ).toBeInTheDocument()
  })

  it('parses a pasted provider instruction into record drafts (§6.3.3c)', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '案内文を貼り付ける' }))
    const dialog = await screen.findByRole('dialog')
    const textarea = within(dialog).getByLabelText('設定案内のテキスト')
    await user.click(textarea)
    await user.paste('以下を設定してください。\nType: A\nName: @\nValue: 203.0.113.5')
    await user.click(within(dialog).getByRole('button', { name: '読み取る' }))

    // 説明文の行は黙って捨てず「読み取れなかった行」に出る。
    expect(within(dialog).getByText('読み取れなかった行')).toBeInTheDocument()
    expect(within(dialog).getByText('以下を設定してください。')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'レコード案に追加' }))
    expect(screen.getByDisplayValue('203.0.113.5')).toBeInTheDocument()
  })

  it('confirms the plain-language summary before saving and can return to the editor', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '203.0.113.10')
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))

    expect(await screen.findByText('この内容で保存します')).toBeInTheDocument()
    // DNSの読み方を知らなくても内容が確認できること。
    expect(
      screen.getByText('teamc-demo.com を開いた人に、203.0.113.10 のサーバーの内容を表示します。'),
    ).toBeInTheDocument()

    // 確認画面で戻っても入力は残り、保存はまだ行われていない。
    await user.click(screen.getByRole('button', { name: '入力に戻る' }))
    expect(await screen.findByDisplayValue('203.0.113.10')).toBeInTheDocument()
    expect(fakeBackend.dnsRecords()['teamc-demo.com']).toBeUndefined()
  })

  it('shows only the fields a beginner needs (TTLは畳む・優先度はMXだけ)', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    expect(screen.queryByLabelText('TTL（秒）')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('優先度')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '詳しい設定（TTL）' }))
    expect(screen.getByLabelText('TTL（秒）')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('種別'), 'MX')
    expect(screen.getByLabelText('優先度')).toBeInTheDocument()
  })

  it('tells the user what to do next after a successful save', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.type(screen.getByLabelText('値'), '76.76.21.21')
    await user.click(screen.getByRole('button', { name: '確認へ進む' }))
    await user.click(await screen.findByRole('button', { name: '保存する' }))

    expect(await screen.findByText('次にやること')).toBeInTheDocument()
    expect(
      screen.getByText(
        '「反映待ち」と出ても失敗ではありません。行き渡るまで通常数分、長いときは48時間ほどかかります。',
      ),
    ).toBeInTheDocument()
  })

  it('blocks saving on a root CNAME (§6.3.3e)', async () => {
    const user = await openRecordMode()

    await user.click(await screen.findByRole('button', { name: '自分で入力する' }))
    await user.selectOptions(screen.getByLabelText('種別'), 'CNAME')
    await user.type(screen.getByLabelText('名前'), '@')
    await user.type(screen.getByLabelText('値'), 'cname.example.com')

    expect(
      await screen.findByText('ルートドメインにCNAMEは設定できません。Aレコードを使ってください。'),
    ).toBeInTheDocument()
    // 誤りが見えている間は確認ステップへ進ませない（保存はその先にある）。
    expect(screen.getByRole('button', { name: '確認へ進む' })).toBeDisabled()
  })
})
