/**
 * ヒーローの木（HeroTree）。ここで守っているのは5つ。
 *
 * 1. 未ログインの木は純粋な装飾で、支援技術から見えない
 * 2. ログイン後は「1件＝1つのマーカー」が付き、名前・状態・残り日数が読み上げ
 *    られる（絵の上には文字を一切描かない）
 * 3. 件数で木が育ち、マーカーの数も件数に一致する
 * 4. 上限を超えた分は黙って捨てず、件数を木の下に出す
 * 5. 「この木について」はログイン前でも読める（取得前の人への説明が主な役目）
 *
 * どのマーカーが出るかの対応そのものは heroTreeMarkerKind.test.ts が持つ。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../../auth/authContext'
import { UNAUTHENTICATED_STATE, authenticatedState } from '../../auth/authTypes'
import type { MyDomainSummary } from '../../api/myDomainsApi'
import { HeroTree } from './HeroTree'

const { fetchMyDomainsMock } = vi.hoisted(() => ({ fetchMyDomainsMock: vi.fn() }))
vi.mock('../../api/myDomainsApi', () => ({ fetchMyDomains: fetchMyDomainsMock }))

const DAY = 24 * 60 * 60 * 1000
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString()

function domain(
  name: string,
  days: number | null = 300,
  statuses: string[] = ['ok'],
  lifecycle: MyDomainSummary['lifecycle'] = 'active',
): MyDomainSummary {
  return {
    name,
    registry: 'kitaqsign',
    lifecycle,
    statuses,
    rgpStatuses: [],
    exDate: days === null ? '' : inDays(days),
    autoRenew: true,
  }
}

const AUTH_METHODS = {
  restoreError: null,
  login: vi.fn(),
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  recheckSession: vi.fn(),
} satisfies Omit<AuthContextValue, 'state'>

function renderTree(state: AuthContextValue['state']) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthContext.Provider value={{ state, ...AUTH_METHODS }}>
        <Routes>
          <Route path="/" element={<HeroTree />} />
          {/* マーカーを押した先。実画面の代わりに、行き先が分かる目印だけを置く。 */}
          <Route path="/mypage/domains/:name" element={<p>詳細画面</p>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

const SIGNED_IN = authenticatedState({ id: 'u1', email: 'dev@example.com', displayName: 'dev' })
/** 木の上のマーカー（「この木について」ボタンは除く）。 */
const markers = () => screen.queryAllByRole('button').filter((el) => el.tagName === 'circle')

beforeEach(() => {
  fetchMyDomainsMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('未ログイン', () => {
  it('ただの木を出し、支援技術からは隠す（装飾）', () => {
    const { container } = renderTree(UNAUTHENTICATED_STATE)

    expect(fetchMyDomainsMock).not.toHaveBeenCalled()
    expect(container.querySelector('svg.hero-tree')).toHaveAttribute('aria-hidden', 'true')
    expect(markers()).toHaveLength(0)
  })

  it('「この木について」は未ログインでも読める（取得前の人への説明）', async () => {
    renderTree(UNAUTHENTICATED_STATE)

    await userEvent.click(screen.getByRole('button', { name: 'この木について' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/ドメインを取得すると、この木に実や生きものが増えます/)).toBeInTheDocument()
    expect(within(dialog).getByText('熟した実')).toBeInTheDocument()
    expect(within(dialog).getByText('枯れた花')).toBeInTheDocument()
    // 0件のときは「いま」の列を出さない
    expect(within(dialog).queryByText('いま')).not.toBeInTheDocument()
  })
})

describe('ログイン後', () => {
  it('保有ドメインをマーカーにし、名前・状態・残り日数を読み上げ可能にする', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('shop.com', 200)] })

    const { container } = renderTree(SIGNED_IN)

    expect(await screen.findByRole('button', { name: /^shop\.com：使えています（更新まであと\d+日）$/ })).toBeInTheDocument()
    // 絵の上に文字は描かない — 名前は吹き出しと aria-label にしかない
    expect(container.querySelector('svg.hero-tree text')).not.toBeInTheDocument()
  })

  it('マーカーの数は保有件数と一致する', async () => {
    fetchMyDomainsMock.mockResolvedValue({
      domains: [domain('a.com'), domain('b.com'), domain('c.com')],
    })

    renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^a\.com/ })

    expect(markers()).toHaveLength(3)
  })

  it('複数のステータスからは、いちばん手当てが要るものを吹き出しに出す', async () => {
    fetchMyDomainsMock.mockResolvedValue({
      domains: [domain('locked.com', 200, ['ok', 'clientTransferProhibited'])],
    })

    renderTree(SIGNED_IN)
    expect(await screen.findByRole('button', { name: /引っ越しをロック中/ })).toBeInTheDocument()
  })

  it('ホバーで名前・状態・残り日数を吹き出しに出す', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('shop.com', 12, ['clientHold'])] })

    renderTree(SIGNED_IN)
    const marker = await screen.findByRole('button', { name: /^shop\.com/ })

    expect(screen.queryByText('一時停止中です')).not.toBeInTheDocument()
    await userEvent.hover(marker)
    expect(await screen.findByText('一時停止中です')).toBeInTheDocument()
    expect(screen.getByText(/更新まであと\d+日/)).toBeInTheDocument()
  })

  it('指したときだけ、絵とほかのマーカーを引かせる', async () => {
    fetchMyDomainsMock.mockResolvedValue({
      domains: [domain('a.com'), domain('b.com'), domain('c.com')],
    })

    const { container } = renderTree(SIGNED_IN)
    const marker = await screen.findByRole('button', { name: /^a\.com/ })

    expect(container.querySelector('.hero-tree-veil')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.hero-tree-marker.is-dimmed')).toHaveLength(0)

    await userEvent.hover(marker)
    expect(container.querySelector('.hero-tree-veil')).toBeInTheDocument()
    expect(container.querySelectorAll('.hero-tree-marker.is-dimmed')).toHaveLength(2)
    // 拡大は配置属性を持たない内側のグループに付く（外側に付けると原点へ飛ぶ）。
    expect(container.querySelectorAll('.hero-tree-marker-zoom.is-on')).toHaveLength(1)
  })

  it('プレミアムTLDにはきらめきが添えられる', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('vip.ceo', 200), domain('plain.com', 200)] })

    const { container } = renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^vip\.ceo：プレミアムTLD・/ })

    expect(container.querySelectorAll('.hero-tree-sparkle')).toHaveLength(1)
  })

  it('マーカーを押すとそのドメインの詳細へ行く', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('shop.com')] })

    renderTree(SIGNED_IN)
    await userEvent.click(await screen.findByRole('button', { name: /^shop\.com/ }))

    expect(await screen.findByText('詳細画面')).toBeInTheDocument()
  })

  it('マーカーは Enter でも開ける（キーボードだけで届く）', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('shop.com')] })

    renderTree(SIGNED_IN)
    const marker = await screen.findByRole('button', { name: /^shop\.com/ })
    marker.focus()
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByText('詳細画面')).toBeInTheDocument()
  })

  it('使用不可（移管済み / 復旧不可）は木に出さない', async () => {
    fetchMyDomainsMock.mockResolvedValue({
      domains: [domain('left.com', 200, ['ok'], 'gone'), domain('here.com', 200)],
    })

    renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^here\.com/ })
    expect(screen.queryByRole('button', { name: /left\.com/ })).not.toBeInTheDocument()
  })

  it('件数で木が育つ（1-2件=芽 / 3-5件=若木 / 6件以上=大樹）', async () => {
    const grown = async (count: number) => {
      fetchMyDomainsMock.mockResolvedValue({
        domains: Array.from({ length: count }, (_, index) => domain(`d${index}.com`)),
      })
      const { container } = renderTree(SIGNED_IN)
      await screen.findByRole('button', { name: /^d0\.com/ })
      const art = container.querySelector('image')?.getAttribute('href') ?? ''
      cleanup()
      return art
    }

    expect(await grown(1)).toContain('sprout')
    expect(await grown(2)).toContain('sprout')
    expect(await grown(3)).toContain('sapling')
    expect(await grown(5)).toContain('sapling')
    expect(await grown(6)).toContain('tree')
  })

  it('上限（40件）を超えた分は、黙って捨てずに件数を出す', async () => {
    fetchMyDomainsMock.mockResolvedValue({
      domains: Array.from({ length: 46 }, (_, index) => domain(`d${index}.com`)),
    })

    renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^d0\.com/ })

    expect(markers()).toHaveLength(40)
    expect(screen.getByText('ほかに6件')).toBeInTheDocument()
  })

  it('上限内なら「ほかに◯件」は出さない', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('only.com')] })

    renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^only\.com/ })

    expect(screen.queryByText(/ほかに/)).not.toBeInTheDocument()
  })

  it('数が増えるほどマーカーと当たり判定を小さくする（重ならないように）', async () => {
    const measure = async (count: number) => {
      fetchMyDomainsMock.mockResolvedValue({
        domains: Array.from({ length: count }, (_, index) => domain(`d${index}.com`)),
      })
      const { container } = renderTree(SIGNED_IN)
      await screen.findByRole('button', { name: /^d0\.com/ })
      const hit = Number(container.querySelector('.hero-tree-hit')?.getAttribute('r'))
      const scale = Number(
        container.querySelector('.hero-tree-marker')?.getAttribute('transform')?.match(/scale\(([\d.]+)/)?.[1],
      )
      cleanup()
      return { hit, scale }
    }

    const few = await measure(12)
    const many = await measure(40)
    expect(many.scale).toBeLessThan(few.scale)
    expect(many.hit).toBeLessThan(few.hit)
    // 40件でも指で狙える大きさは残す（共通座標で 20 以上 = 画面上 11px 以上）。
    expect(many.hit).toBeGreaterThan(20)
  })

  it('「この木について」にはいまの件数も出る', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [domain('a.com', 12), domain('b.com', 12)] })

    renderTree(SIGNED_IN)
    await screen.findByRole('button', { name: /^a\.com/ })
    await userEvent.click(screen.getByRole('button', { name: 'この木について' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('いま')).toBeInTheDocument()
    expect(within(dialog).getByText('2件')).toBeInTheDocument()
  })

  it('0件ならただの木に戻る', async () => {
    fetchMyDomainsMock.mockResolvedValue({ domains: [] })

    const { container } = renderTree(SIGNED_IN)

    await waitFor(() => expect(fetchMyDomainsMock).toHaveBeenCalled())
    expect(markers()).toHaveLength(0)
    expect(container.querySelector('svg.hero-tree')).toHaveAttribute('aria-hidden', 'true')
  })

  it('一覧が引けなくても、エラーではなくただの木に戻る', async () => {
    fetchMyDomainsMock.mockRejectedValue(new Error('offline'))

    const { container } = renderTree(SIGNED_IN)

    await waitFor(() => expect(fetchMyDomainsMock).toHaveBeenCalled())
    expect(container.querySelector('svg.hero-tree')).toHaveAttribute('aria-hidden', 'true')
    expect(markers()).toHaveLength(0)
  })
})
