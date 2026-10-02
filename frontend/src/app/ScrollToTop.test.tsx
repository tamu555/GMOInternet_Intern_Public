/**
 * ルート遷移時のスクロールリセット（issue #83）。
 *
 * jsdom にレイアウトは無いので、位置そのものは検証できない。ここで守るのは
 * 「いつ呼ぶか / いつ呼ばないか」— 前進の遷移では必ず先頭へ戻し、ブラウザの
 * 「戻る」には割り込まない、という規則のほう。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter, Link, Outlet } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScrollToTop } from './ScrollToTop'

function Shell() {
  return (
    <>
      <ScrollToTop />
      <Outlet />
    </>
  )
}

const ROUTES = [
  {
    element: <Shell />,
    children: [
      {
        path: '/',
        element: (
          <div>
            <h1>トップ</h1>
            <Link to="/next">次へ</Link>
            <Link to="/#anchor">見出しへ</Link>
            <h2 id="anchor">アンカー</h2>
          </div>
        ),
      },
      {
        path: '/next',
        element: (
          <div>
            <h1>次のページ</h1>
            <Link to="/">戻る</Link>
          </div>
        ),
      },
    ],
  },
]

function renderRouter() {
  const router = createMemoryRouter(ROUTES, { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScrollToTop', () => {
  it('前進の遷移（PUSH）でページ先頭へ戻す', async () => {
    const user = userEvent.setup()
    renderRouter()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    await user.click(screen.getByRole('link', { name: '次へ' }))
    expect(await screen.findByRole('heading', { name: '次のページ' })).toBeInTheDocument()

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 })
  })

  /**
   * ⚠️ 「戻る」には割り込まない。同一ドキュメント履歴のスクロール復元は
   * ブラウザが持っており、ここで先頭へ飛ばすと、長い検索結果から詳細を見て
   * 戻ってきた人が毎回いちばん上に放り出される。
   */
  it('ブラウザの「戻る」（POP）では動かない', async () => {
    const user = userEvent.setup()
    const router = renderRouter()

    await user.click(screen.getByRole('link', { name: '次へ' }))
    expect(await screen.findByRole('heading', { name: '次のページ' })).toBeInTheDocument()

    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    await router.navigate(-1)
    expect(await screen.findByRole('heading', { name: 'トップ' })).toBeInTheDocument()

    expect(scrollTo).not.toHaveBeenCalled()
  })

  /** ページ内アンカー（フッターの `/#tlds` など）は、先頭ではなくその要素へ。 */
  it('ハッシュ付きの遷移では対象の要素へ送る', async () => {
    const user = userEvent.setup()
    renderRouter()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {})

    await user.click(screen.getByRole('link', { name: '見出しへ' }))

    expect(scrollIntoView).toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
