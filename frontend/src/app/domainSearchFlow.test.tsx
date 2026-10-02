/**
 * Integration tests for FIG.1's left half (docs/api-flow-diagrams.html):
 * search (always across every supported TLD) -> per-TLD availability table ->
 * cart selection -> hand-off to the application form; plus the verified
 * similar-domain suggestions when nothing is available. Drives the real
 * router; search + TLD data go through the fakeBackend callable fakes
 * (domainsSearchApi speaks Firebase callables now), while the login
 * round-trips stay on the MSW auth handlers.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { clearAccessToken } from '../auth/tokenStorage'
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

const RESULTS_HEADING = 'ご希望のドメインを選択してください'

/**
 * Matches a price line by the text it renders. The label and the figure sit in
 * separate boxes so the figures line up in a column across the result list, so
 * the line is a whole-subtree match rather than a single text node.
 */
function priceLine(text: string) {
  return (_content: string, element: Element | null) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() === text
}

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

async function searchFor(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.type(await screen.findByLabelText('取得したいドメイン名'), label)
  await user.click(screen.getByRole('button', { name: '検索する' }))
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  // The token is mirrored in module memory; clearing storage alone would leak
  // a login from a previous test into the logged-out ones.
  clearAccessToken()
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

describe('FIG.1 public top page', () => {
  it('shows the search screen at / without a login (no redirect)', async () => {
    renderApp('/')

    // The redesigned search page renders two h1s named ドメイン検索 (page
    // header + hero eyebrow), so the single-element query would throw.
    expect((await screen.findAllByRole('heading', { name: 'ドメイン検索' }))[0]).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(screen.getByText('AuthContext: 未認証')).toBeInTheDocument()
    // Unauthenticated: the header offers login/register, not the admin button.
    // Scoped to the banner landmark - the footer sitemap carries links with
    // the same names, so an unscoped query would be ambiguous.
    const header = within(screen.getByRole('banner'))
    expect(header.getByRole('link', { name: 'ログイン' })).toBeInTheDocument()
    expect(header.getByRole('link', { name: '会員登録' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'マイページへ' })).not.toBeInTheDocument()
  })

  it('shows the マイページ entry only when logged in', async () => {
    loginAsDemoUser()
    renderApp('/')

    // ヒーローに置いていた「マイページへ」ボタンは 2026-08-28 に削除（利用者の
    // 指摘）。ログイン後の入口はヘッダーのナビ 1 か所に集約されている。
    const header = within(screen.getByRole('banner'))
    expect(await header.findByRole('link', { name: 'マイページ' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'マイページへ' })).not.toBeInTheDocument()
  })

  it('redirects the legacy /domains route to / and still searches every TLD (old tlds param ignored)', async () => {
    renderApp('/domains?q=myshop&tlds=.com')

    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    // The search is no longer limited to the TLDs in the legacy parameter.
    expect(screen.getByRole('button', { name: 'myshop.xyz を選択' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})

describe('FIG.1 search state in the URL', () => {
  it('writes the executed search into the query parameter', async () => {
    const user = userEvent.setup()

    renderApp('/')
    await searchFor(user, 'myshop')

    await screen.findByRole('heading', { name: RESULTS_HEADING })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('q')).toBe('myshop')
  })

  it('restores form state and results from the URL alone (reload / shared link / login round-trip)', async () => {
    renderApp('/?q=myshop')

    // No clicks: the search re-runs from the query parameter, across all TLDs.
    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: RESULTS_HEADING })).toBeInTheDocument()
    expect(screen.getByLabelText('取得したいドメイン名')).toHaveValue('myshop')
  })

  it('does not run a search from an invalid query parameter', async () => {
    renderApp('/?q=my_shop')

    // The redesigned search page renders two h1s named ドメイン検索 (page
    // header + hero eyebrow), so the single-element query would throw.
    expect((await screen.findAllByRole('heading', { name: 'ドメイン検索' }))[0]).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: RESULTS_HEADING })).not.toBeInTheDocument()
  })
})

describe('FIG.1 search form validation (spec §3.4)', () => {
  it('blocks submission of a label with a disallowed character and shows the field error', async () => {
    const user = userEvent.setup()

    renderApp('/')
    await searchFor(user, 'my_shop')

    expect(await screen.findByText('英数字とハイフンのみ使用できます。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: RESULTS_HEADING })).not.toBeInTheDocument()
  })

  it('normalizes full-width characters and surrounding whitespace before searching', async () => {
    const user = userEvent.setup()

    renderApp('/')
    await searchFor(user, '　ｍｙｓｈｏｐ　')

    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
  })
})

describe('FIG.1 result table (spec §6.7)', () => {
  it('shows every searched TLD at once, with no pager left to hide the tail', async () => {
    const user = userEvent.setup()

    renderApp('/')
    await searchFor(user, 'myshop')

    await screen.findByRole('heading', { name: RESULTS_HEADING })
    // 22 TLDs searched -> 22 selectable rows on the page, first and last alike.
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'myshop.ceo を選択' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^myshop\..+ を選択$/ })).toHaveLength(22)
    expect(screen.queryByRole('button', { name: '次へ ›' })).not.toBeInTheDocument()
  })

  it('shows first-year and renewal at one shared font size (spec §6.2.5)', async () => {
    const user = userEvent.setup()

    renderApp('/')
    await searchFor(user, 'myshop')

    await screen.findByRole('heading', { name: RESULTS_HEADING })
    // .com's row: both figures are present and rendered by ONE shared class,
    // so the renewal price can never be typeset quieter than the first year.
    // (.build shares the ¥1,480 first-year figure and .xyz the ¥1,980 renewal
    // one now that every TLD is on the page, so both queries are row-scoped.)
    const comRow = within(screen.getByText('myshop.com').closest('li') as HTMLElement)
    const firstYear = comRow.getByText(priceLine('初年度 ¥1,480'))
    const renewal = comRow.getByText(priceLine('更新 ¥1,980'))
    expect(firstYear.className).toBe(renewal.className)
  })

  it('never renders 使用中 for a TLD whose registry timed out - only the third state', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('partial-registry-timeout')

    renderApp('/')
    await searchFor(user, 'myshop')

    // kitaqnic-routed .xyz shows the third state...
    expect(await screen.findByRole('img', { name: 'myshop.xyz は確認できませんでした' })).toBeInTheDocument()
    // ...kitaqsign-routed .com stays selectable...
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    // ...and nothing on the page claims 使用中.
    expect(screen.queryByRole('img', { name: /使用中/ })).not.toBeInTheDocument()
  })

  it('lists an unreachable-registry TLD as not purchasable instead of hiding it (spec §6.9)', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('kitaqnic-unavailable')

    renderApp('/')
    await searchFor(user, 'myshop')

    // kitaqnic-routed .xyz stays listed, marked ⏳ and not selectable...
    expect(
      await screen.findByRole('img', {
        name: 'myshop.xyz はレジストリに接続できないため一時的に購入できません',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'myshop.xyz を選択' })).not.toBeInTheDocument()
    // ...kitaqsign-routed .com is untouched by the other registry's window...
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    // ...the banner says why, without claiming maintenance...
    expect(screen.getAllByText(/ただいま一部のレジストリに接続しづらい状況です/)[0]).toBeInTheDocument()
    // ...and nothing claims 使用中 or the transient-looking third state.
    expect(screen.queryByRole('img', { name: /使用中/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /確認できませんでした/ })).not.toBeInTheDocument()
  })

  it('marks a TLD whose registry announced maintenance as メンテナンス中, with the end time', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('kitaqnic-maintenance')

    renderApp('/')
    await searchFor(user, 'myshop')

    // kitaqnic-routed .xyz stays listed, marked 🔧 and not selectable...
    expect(
      await screen.findByRole('img', {
        name: 'myshop.xyz はレジストリがメンテナンス中のため購入できません',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'myshop.xyz を選択' })).not.toBeInTheDocument()
    // ...kitaqsign-routed .com is untouched by the other registry's window...
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    // ...and the banner names maintenance and the announced end
    // (FAKE_MAINTENANCE_UNTIL, rendered in local time).
    expect(
      screen.getAllByText(/一部のレジストリがメンテナンス中です/)[0],
    ).toBeInTheDocument()
    expect(screen.getAllByText(/終了予定: /)[0]).toBeInTheDocument()
    // ...while the weaker unreachable wording stays absent.
    expect(screen.queryByText(/接続しづらい状況です/)).not.toBeInTheDocument()
  })

  it('shows an honest empty suggestion state - not a fabricated candidate - when every TLD is taken', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('all-taken')

    renderApp('/')
    await searchFor(user, 'myshop')

    expect(await screen.findByRole('img', { name: 'myshop.com は使用中' })).toBeInTheDocument()
    expect(
      await screen.findByText('類似候補も見つかりませんでした。別の文字列でお試しください。'),
    ).toBeInTheDocument()
  })

  it('shows the retry-later message and no result table on a server error', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('server-error')

    renderApp('/')
    await searchFor(user, 'myshop')

    // One slot, not two: the reason lives inside the failure panel on the
    // result screen, so there is no separate banner repeating it.
    expect(await screen.findByText('時間をおいて再度お試しください。')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: RESULTS_HEADING })).not.toBeInTheDocument()
  })
})

/**
 * docs/仕様/registry-unavailable.md: a registry that answers 503 before its
 * circuit has opened leaves `searchDomains` with nothing to report, so the
 * whole call fails. When BOTH registries are in that state the search cannot
 * produce a single row - and the screen used to stay exactly as it was, which
 * read as "the 検索する button does nothing".
 */
describe('FIG.1 full registry outage (spec §6.9)', () => {
  const OUTAGE_MESSAGE = 'レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。'

  it('still opens the result screen and explains why nothing could be checked', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('all-registries-down')

    renderApp('/')
    await searchFor(user, 'myshop')

    // The result screen is reached, not skipped...
    expect(await screen.findByRole('heading', { name: '空き状況を確認できませんでした' })).toBeInTheDocument()
    expect(screen.getByText(OUTAGE_MESSAGE)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument()
    // ...the search is still in the URL, so the link stays shareable...
    expect(new URLSearchParams(window.location.search).get('q')).toBe('myshop')
    // ...and nothing is claimed about any single TLD.
    expect(screen.queryByRole('heading', { name: RESULTS_HEADING })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /使用中/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /を選択$/ })).not.toBeInTheDocument()
  })

  it('re-runs the same search from 再試行 and shows the results once the registries are back', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('all-registries-down')

    renderApp('/')
    await searchFor(user, 'myshop')
    await screen.findByRole('heading', { name: '空き状況を確認できませんでした' })

    fakeBackend.setSearchMode('all-available')
    await user.click(screen.getByRole('button', { name: '再試行' }))

    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(screen.queryByText(OUTAGE_MESSAGE)).not.toBeInTheDocument()
  })

  it('lists every TLD as ⏳ once both circuits are open (the partial path, all of it)', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('all-unavailable')

    renderApp('/')
    await searchFor(user, 'myshop')

    // Judged unreachable is a per-TLD verdict, so the table still renders -
    // this branch must not regress into the whole-call failure above.
    expect(
      await screen.findByRole('img', {
        name: 'myshop.com はレジストリに接続できないため一時的に購入できません',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: RESULTS_HEADING })).toBeInTheDocument()
    expect(screen.getAllByText(/ただいま一部のレジストリに接続しづらい状況です/)[0]).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /を選択$/ })).not.toBeInTheDocument()
  })
})

describe('FIG.1 re-submitting the same query', () => {
  it('asks the registry again even when the label has not changed', async () => {
    const user = userEvent.setup()

    renderApp('/?q=myshop')
    await screen.findByRole('heading', { name: RESULTS_HEADING })
    const before = fakeBackend.callCount('searchDomains')

    // Same label, same URL: the only thing that changed is that the user
    // asked again - which after an outage is the whole point.
    await user.click(screen.getByRole('button', { name: '再検索' }))

    await vi.waitFor(() => {
      expect(fakeBackend.callCount('searchDomains')).toBe(before + 1)
    })
    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('q')).toBe('myshop')
  })

  it('keeps the results on screen while the same query is being re-run', async () => {
    const user = userEvent.setup()

    renderApp('/?q=myshop')
    await screen.findByRole('heading', { name: RESULTS_HEADING })

    // The re-run never answers, so whatever is on screen below is the
    // PREVIOUS result: a page that tore its results down while asking again
    // would be showing the landing hero here instead.
    fakeBackend.on('searchDomains', () => new Promise(() => {}))
    await user.click(screen.getByRole('button', { name: '再検索' }))

    expect(screen.getByRole('heading', { name: RESULTS_HEADING })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /確認中…/ })).toBeInTheDocument()
  })
})

describe('FIG.1 selection cart', () => {
  it('collects selections, keeps them across re-orderings, and can remove or clear them', async () => {
    const user = userEvent.setup()

    renderApp('/?q=myshop')
    await user.click(await screen.findByRole('button', { name: 'myshop.com を選択' }))
    await user.click(screen.getByRole('button', { name: 'myshop.net を選択' }))

    expect(screen.getByText('2件')).toBeInTheDocument()
    // Two selected -> the one-order-at-a-time note is shown up front.
    expect(screen.getByText(/申込フォームは1件ずつのため/)).toBeInTheDocument()
    // Per-item 3-year total (spec §6.2.5): .com = 1480 + 1980*2.
    expect(screen.getByText('3年間の合計 ¥5,440')).toBeInTheDocument()

    // The selection survives re-ordering the list.
    await user.click(screen.getByRole('button', { name: '初年度が安い順' }))
    expect(screen.getByRole('button', { name: 'myshop.com を選択' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'myshop.net を選択から外す' }))
    expect(screen.getByText('1件')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'すべての選択を削除' }))
    expect(screen.getByText('0件')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '次へ進む' })).toBeDisabled()
  })

  it('offers the bottom re-search bar and re-runs the search with a new label', async () => {
    const user = userEvent.setup()

    renderApp('/?q=myshop')
    await screen.findByRole('heading', { name: RESULTS_HEADING })

    const researchInput = screen.getAllByLabelText('取得したいドメイン名').at(-1) as HTMLElement
    await user.clear(researchInput)
    await user.type(researchInput, 'othersite')
    await user.click(screen.getByRole('button', { name: '再検索' }))

    expect(await screen.findByRole('button', { name: 'othersite.com を選択' })).toBeInTheDocument()
    expect(new URLSearchParams(window.location.search).get('q')).toBe('othersite')
  })
})

describe('FIG.1 TLD list (spec §4.3)', () => {
  it('falls back to the static TLD list and shows a notice when the fetch fails', async () => {
    fakeBackend.setTldsMode('server-error')

    renderApp('/?q=myshop')

    // The redesigned page renders the fallback notice in two layout slots.
    expect(
      (await screen.findAllByText('対応TLDの一覧を取得できなかったため、確認済みの一部のTLDのみ表示しています。'))[0],
    ).toBeInTheDocument()
    // Fallback = Kitaqsign's confirmed 4 only; no kitaqnic column appears.
    expect(await screen.findByRole('button', { name: 'myshop.com を選択' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'myshop.xyz を選択' })).not.toBeInTheDocument()
  })
})

describe('FIG.1 -> FIG.2 hand-off', () => {
  it('carries the whole selection to the application form when logged in', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()

    renderApp('/?q=myshop')
    await user.click(await screen.findByRole('button', { name: 'myshop.com を選択' }))
    await user.click(screen.getByRole('link', { name: '次へ進む' }))

    expect(await screen.findByRole('heading', { name: '申込フォーム' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/domains/new')
    expect(new URLSearchParams(window.location.search).getAll('domain')).toEqual(['myshop.com'])
  })

  it('accepts a TLD outside the local price table at the server default price instead of bouncing to search', async () => {
    // Regression: the live registry TLD list can outgrow tldData.ts. Such a
    // domain used to hit parseOrderableDomain's null and get bounced with
    // 「申し込むドメインを特定できませんでした」 despite the backend accepting
    // the order at its DEFAULT_PRICE.
    loginAsDemoUser()

    renderApp('/domains/new?domain=myshop.unlisted')

    expect(await screen.findByRole('heading', { name: '申込フォーム' })).toBeInTheDocument()
    expect(screen.queryByText(/申し込むドメインを特定できませんでした/)).not.toBeInTheDocument()
    expect(screen.getByText('myshop.unlisted')).toBeInTheDocument()
    // The quoted total is the backend's fallback figure (1 year = ¥1,500).
    expect(screen.getAllByText('¥1,500').length).toBeGreaterThan(0)
  })

  it('bounces an unauthenticated 次へ進む to login and returns to the application form via returnTo', async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({
      user: { getIdToken: vi.fn().mockResolvedValue('id-token') },
    } as unknown as Awaited<ReturnType<typeof signInWithEmailAndPassword>>)
    const user = userEvent.setup()

    renderApp('/?q=myshop')
    await user.click(await screen.findByRole('button', { name: 'myshop.com を選択' }))
    await user.click(screen.getByRole('link', { name: '次へ進む' }))

    // The guard, not the CTA, owns this redirect - and it keeps the query.
    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBe('/domains/new?domain=myshop.com')

    await user.type(screen.getByLabelText('メールアドレス'), 'demo@example.com')
    await user.type(screen.getByLabelText('パスワード'), 'password123')
    await user.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByRole('heading', { name: '申込フォーム' })).toBeInTheDocument()
    expect(screen.getByText('myshop.com')).toBeInTheDocument()
  })
})

describe('空き待ち通知 (docs/仕様/domain-watch.md)', () => {
  it('registers a watch from a taken cell and marks it 登録済み', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    fakeBackend.setSearchMode('all-taken')

    renderApp('/')
    await searchFor(user, 'myshop')

    await user.click(
      await screen.findByRole('button', {
        name: 'myshop.com が購入できるようになったら通知を受け取る',
      }),
    )

    // The banner promises a NOTICE, never the name itself (first come first
    // served among watchers), and the cell stops offering the button.
    expect(
      (
        await screen.findAllByText(
          'myshop.com を空き待ちに登録しました。購入できる状態を確認でき次第、マイページでお知らせします。',
        )
      )[0],
    ).toBeInTheDocument()
    expect(screen.getAllByText('空き待ち登録済み').length).toBeGreaterThan(0)
    expect(
      screen.queryByRole('button', {
        name: 'myshop.com が購入できるようになったら通知を受け取る',
      }),
    ).not.toBeInTheDocument()
    expect(fakeBackend.watches().map((watch) => watch.domainName)).toContain('myshop.com')
  })

  it('offers the watch on a maintenance cell too — the case that motivated the feature', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    fakeBackend.setSearchMode('kitaqnic-maintenance')

    renderApp('/')
    await searchFor(user, 'myshop')

    await user.click(
      await screen.findByRole('button', {
        name: 'myshop.xyz が購入できるようになったら通知を受け取る',
      }),
    )

    expect(fakeBackend.watches().map((watch) => watch.domainName)).toContain('myshop.xyz')
  })

  it('sends an unauthenticated watch click to login with returnTo preserving the search', async () => {
    const user = userEvent.setup()
    fakeBackend.setSearchMode('all-taken')

    renderApp('/')
    await searchFor(user, 'myshop')

    await user.click(
      await screen.findByRole('button', {
        name: 'myshop.com が購入できるようになったら通知を受け取る',
      }),
    )

    expect(await screen.findByRole('heading', { name: 'ログイン' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem('registrar.auth.returnTo')).toBe('/?q=myshop')
    // Nothing was registered on the anonymous click.
    expect(fakeBackend.watches()).toHaveLength(0)
  })

  it('never offers the watch on the transient ？ state (nothing to promise)', async () => {
    const user = userEvent.setup()
    loginAsDemoUser()
    fakeBackend.setSearchMode('partial-registry-timeout')

    renderApp('/')
    await searchFor(user, 'myshop')

    await screen.findByRole('img', { name: 'myshop.xyz は確認できませんでした' })
    expect(
      screen.queryByRole('button', {
        name: 'myshop.xyz が購入できるようになったら通知を受け取る',
      }),
    ).not.toBeInTheDocument()
  })
})
