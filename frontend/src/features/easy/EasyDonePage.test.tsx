/**
 * 完了画面のチェックリスト（「サイト公開まで、あと何が残っていますか？」）。
 *
 * ここで固定したいのは 1 点だけ:「② サイトの置き場所」を当サービスが
 * 済み／未のどちらかに断定しないこと。置き場所は利用者が別のサービスで契約する
 * ものなので当サービスからは見えず、断定すれば必ずどちらかの人に嘘をつく。
 * ⑥ まで押した人に「公開できました」と言わないのも同じ理由（ホスティングが
 * 無ければ、つなぐ設定を保存してもサイトは表示されない）。
 *
 * もう 1 点、後から足した固定がある: **見出しとチェックリストが同じ判定で動くこと**。
 * ns-guide のサービス（Cloudflare など）を選んで案内側へ出た人は
 * `dnsPlan !== 'later'` のままレコードを 1 件も持たないので、`dnsPlan` で見出しを
 * 分けていたころは「つなぐ設定まで終わりました」と、同じ画面の③「まだです」が
 * 同居していた。
 *
 * ウィザードを歩いて到達する経路そのものは app/easyModeFlow.test.tsx が見ているので、
 * ここは完了画面だけを Context のスタブの上に描いて、状態ごとの表示を確かめる。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EasyDonePage } from './EasyDonePage'
import { EasyContext, type EasyContextValue } from './easyContext'
import {
  EASY_DONE_CONNECTED_CONCLUSION,
  EASY_DONE_PENDING_CONCLUSION,
  EASY_DONE_PLACE_NOTE,
  EASY_JOURNEY_PARTS,
  EASY_JOURNEY_STATUS_LABEL,
} from './easyJourney'
import { dnsPlanLabel } from './easyDnsPlans'
import {
  DONE_DNS_SKIPPED_NOTE,
  DONE_HEADING_CONNECTED,
  DONE_HEADING_SKIPPED,
  DONE_NEXT_HEADING,
  DONE_PLAN_UNSET,
  DONE_SUBLINE_CONNECTED,
  DONE_SUBLINE_SKIPPED,
  DONE_VISIBLE_HEADING,
} from './easyMessages'
import { EMPTY_EASY_SESSION, type EasySession } from './easyTypes'

function renderDone(patch: Partial<EasySession>) {
  const session: EasySession = {
    ...EMPTY_EASY_SESSION,
    purpose: 'business',
    label: 'my-bakery',
    tld: '.com',
    orderId: 'ord-000001',
    domainName: 'my-bakery.com',
    ...patch,
  }
  /* 完了画面が読むのは session と finish() だけ。ほかは呼ばれたら分かるように
     スタブにしておく（呼ばれること自体がこの画面の設計違反になる）。 */
  const value = {
    session,
    completedSteps: [],
    stepErrors: {},
    setStepError: vi.fn(),
    choosePurpose: vi.fn(),
    saveCandidates: vi.fn(),
    toggleFavorite: vi.fn(),
    chooseLabel: vi.fn(),
    chooseTld: vi.fn(),
    setYears: vi.fn(),
    setAutoRenew: vi.fn(),
    chooseDnsPlan: vi.fn(),
    chooseDnsService: vi.fn(),
    setDnsInput: vi.fn(),
    recordOrder: vi.fn(),
    finish: vi.fn(),
    reset: vi.fn(),
  } satisfies EasyContextValue

  return render(
    <MemoryRouter>
      <EasyContext.Provider value={value}>
        <EasyDonePage />
      </EasyContext.Provider>
    </MemoryRouter>,
  )
}

/** 「① ドメイン」「② サイトの置き場所」「③ つなぐ設定」の行を名前で引く。 */
function rowOf(id: 'domain' | 'place' | 'connect'): HTMLElement {
  const part = EASY_JOURNEY_PARTS.find((entry) => entry.id === id)
  if (!part) throw new Error(`unknown part: ${id}`)
  const title = screen.getByText(part.title)
  const row = title.closest('li')
  if (!row) throw new Error(`row not rendered: ${id}`)
  return row
}

afterEach(cleanup)

describe('EasyDonePage のチェックリスト', () => {
  it('つなぐ設定まで終えた人にも「置き場所」は断定せず、確認先だけを渡す', () => {
    renderDone({ dnsPlan: 'web', dnsServiceId: 'vercel' })

    // ①と③は済み。③はレコードを保存した経路なので「済み」と言い切ってよい。
    expect(rowOf('domain')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.done)
    expect(rowOf('connect')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.done)

    /* ②は当サービスからは分からない。done にも todo にも倒さない。 */
    const place = rowOf('place')
    expect(place).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.unknown)
    expect(place).not.toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.done)
    expect(place).not.toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.todo)
    expect(screen.getByText(EASY_DONE_PLACE_NOTE)).toBeInTheDocument()

    // ⚠️ 「公開できました」ではなく、置き場所を条件にした言い方でしか締めない。
    expect(screen.getByText(EASY_DONE_CONNECTED_CONCLUSION)).toBeInTheDocument()
    expect(screen.queryByText(EASY_DONE_PENDING_CONCLUSION)).toBeNull()
  })

  it('つなぐ設定を飛ばした人には、③だけが「まだです」として残る', () => {
    renderDone({ dnsPlan: 'later' })

    expect(rowOf('domain')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.done)
    expect(rowOf('connect')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.todo)
    // ②の扱いは、つないだかどうかで変わらない（当サービスの外の話なので）。
    expect(rowOf('place')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.unknown)

    expect(screen.getByText(EASY_DONE_PENDING_CONCLUSION)).toBeInTheDocument()
    // 既存の案内は消さない。チェックリストは足すものであって置き換えではない。
    expect(screen.getByText(DONE_DNS_SKIPPED_NOTE)).toBeInTheDocument()
  })

  /**
   * ns-guide のサービス（Cloudflare など）は、この画面ではレコードを 1 件も
   * 保存せずに「あとで設定する」で抜ける経路を持つ。サービスを選んだ形跡
   * （dnsServiceId）だけを見て「つなぎ済み」と数えないことを固定する。
   */
  it('ns-guide を選んで抜けた人を「つなぎ済み」と数えない', () => {
    renderDone({ dnsPlan: 'later', dnsServiceId: 'cloudflare' })

    expect(rowOf('connect')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.todo)
  })

  /** 一覧にないサービスは案内文の貼り付けで保存する。こちらは「済み」。 */
  it('案内文を貼り付けて保存した人は「つなぎ済み」と数える', () => {
    renderDone({ dnsPlan: 'web', dnsServiceId: 'paste' })

    expect(rowOf('connect')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.done)
  })
})

/** 見出し下の 1 行はドメイン名と同じ段落に出るので、header ごと見る。 */
function headerBlock(): HTMLElement {
  const heading = screen.getByRole('heading', { level: 1 })
  const header = heading.closest('header')
  if (!header) throw new Error('header not rendered')
  return header
}

describe('EasyDonePage の見出しとチェックリストの一致', () => {
  /**
   * ⚠️ この画面の矛盾は、見出しを `dnsPlan === 'later'` で、チェックリストを
   * 「レコードが保存されたか」で分けていたことから出ていた。ns-guide の
   * サービスを選んで NS 変更の案内側へ出た人はその差分にそのまま落ちる
   * （使いみちは選んでいるので 'later' ではないが、レコードは 1 件も無い）。
   * 見出し・サブライン・バナー・カードが、③ の判定と同じ側に立つことを固定する。
   */
  it('ns-guide の案内側へ出た人には、見出しも案内も「まだつないでいない」側で出す', () => {
    renderDone({ dnsPlan: 'web', dnsServiceId: 'cloudflare' })

    expect(rowOf('connect')).toHaveTextContent(EASY_JOURNEY_STATUS_LABEL.todo)

    expect(headerBlock()).toHaveTextContent(DONE_HEADING_SKIPPED)
    expect(headerBlock()).toHaveTextContent(DONE_SUBLINE_SKIPPED)
    expect(screen.queryByText(DONE_HEADING_CONNECTED)).toBeNull()

    // 「つなぐ設定はまだ」の案内と「このあとすること」が出る側。
    expect(screen.getByText(DONE_DNS_SKIPPED_NOTE)).toBeInTheDocument()
    expect(screen.getByText(DONE_NEXT_HEADING)).toBeInTheDocument()
    // 逆に「いつ見えるようになりますか？」は出さない（まだ何も伝わっていない）。
    expect(screen.queryByText(DONE_VISIBLE_HEADING)).toBeNull()
    expect(screen.getByText(EASY_DONE_PENDING_CONCLUSION)).toBeInTheDocument()
  })

  /**
   * ⚠️ 「設定した内容」の使いみち行**だけ**は判定が違う（`dnsPlan === 'later'`）。
   * 揃っていないのはバグではない: ns-guide で抜けた人も使いみち自体は選んでいるので、
   * ここに DONE_PLAN_UNSET（'まだ決めていません'）を出すと今度はこちらが嘘になる。
   * 「揃えるべきだ」と読んで直されないよう、意図としてここで固定する。
   */
  it('ns-guide で抜けた人の「使いみち」は、選んだ使いみちのまま残す', () => {
    renderDone({ dnsPlan: 'web', dnsServiceId: 'cloudflare' })

    expect(screen.getByText(dnsPlanLabel('web'))).toBeInTheDocument()
    expect(screen.queryByText(DONE_PLAN_UNSET)).toBeNull()
  })

  it('レコードを保存した人には、これまでどおり「つなぐ設定まで終わりました」を出す', () => {
    renderDone({ dnsPlan: 'web', dnsServiceId: 'vercel' })

    expect(headerBlock()).toHaveTextContent(DONE_HEADING_CONNECTED)
    expect(headerBlock()).toHaveTextContent(DONE_SUBLINE_CONNECTED)
    expect(screen.getByText(DONE_VISIBLE_HEADING)).toBeInTheDocument()
    expect(screen.queryByText(DONE_DNS_SKIPPED_NOTE)).toBeNull()
    expect(screen.queryByText(DONE_NEXT_HEADING)).toBeNull()
  })

  it('「あとで設定する」で抜けた人には、これまでどおり「ドメインを取得しました」を出す', () => {
    renderDone({ dnsPlan: 'later' })

    expect(headerBlock()).toHaveTextContent(DONE_HEADING_SKIPPED)
    expect(screen.getByText(DONE_NEXT_HEADING)).toBeInTheDocument()
    // 使いみちを答えていないのはこちらの人だけ。
    expect(screen.getByText(DONE_PLAN_UNSET)).toBeInTheDocument()
  })
})
