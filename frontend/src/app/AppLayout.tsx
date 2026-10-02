import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { LogOut, Menu } from 'lucide-react'
import { useAuth } from '../auth/useAuth'
import { shouldUseMocks } from '../config'
import { MockControlPanel } from '../dev/MockControlPanel'
import { AssistantLauncher } from '../features/assistant/AssistantLauncher'
import { getChatSnapshot, subscribeChatStore } from '../features/assistant/store/chatStore'
import type { WalkthroughState } from '../features/assistant/types'
import { isWalkthroughComplete } from '../features/assistant/walkthrough/walkthroughState'
import { findWalkthroughTemplate, type WalkthroughTemplate } from '../features/assistant/walkthrough/walkthroughTemplates'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrandMark } from '../components/BrandMark'
import { LogoutConfirmDialog } from '../components/LogoutConfirmDialog'
import { cn } from '@/lib/utils'
import { ScrollToTop } from './ScrollToTop'

/* Sonner reads window.matchMedia on mount; the jsdom test environment does not
   provide it, so the Toaster only mounts where the API exists (all browsers). */
/* ヘッダーは sticky で固定されている。ヒーローも内部画面の上端も --grass-1 の
   帯なので、ヘッダーまで grass-1 で塗ると地と同色になり、バーの輪郭が消える。
   ヘッダーだけは別の面（--header-surface）として塗り、境界線は最上部でも常に
   引く。スクロール中はそれを半透明＋ぼかし＋影に切り替えて、下のコンテンツが
   潜っている手前の層であることを示す。 */
function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const sync = () => setScrolled(window.scrollY > threshold)
    sync()
    window.addEventListener('scroll', sync, { passive: true })
    return () => window.removeEventListener('scroll', sync)
  }, [threshold])
  return scrolled
}

const supportsToaster = typeof window !== 'undefined' && typeof window.matchMedia === 'function'

const STATUS_LABELS = {
  checking: '確認中',
  authenticated: '認証済み',
  unauthenticated: '未認証',
} as const

const STATUS_DOTS = {
  checking: 'bg-[var(--orange)]',
  authenticated: 'bg-primary',
  unauthenticated: 'bg-muted-foreground',
} as const

/* The footer sitemap of design_theme/theme-04-3-wakakusa.html, pointed at the
   routes this app actually has (a link with no screen behind it would be a lie
   about what the product does). */
const FOOTER_COLUMNS: { heading: string; links: { label: string; to: string }[] }[] = [
  {
    heading: '検索',
    links: [
      { label: 'ドメイン検索', to: '/' },
      { label: '対応TLDと料金', to: '/#tlds' },
    ],
  },
  {
    heading: 'アカウント',
    links: [
      { label: 'ログイン', to: '/login' },
      { label: '会員登録', to: '/signup' },
      // ドメインの管理画面は「マイページ」1つだけ。/dashboard は製品画面では
      // なく FIG.8 の認証フロー確認用なので、下の別カラムに置いている。
      { label: 'マイページ', to: '/mypage' },
    ],
  },
  {
    heading: 'かんたんに使う',
    links: [
      { label: 'かんたんモード', to: '/easy' },
      { label: '認証の動作確認', to: '/dashboard' },
    ],
  },
]

function navLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'rounded-none px-3 py-1.5 text-sm font-medium no-underline transition-colors',
    isActive
      ? 'bg-grass-2 font-bold text-green-darkest'
      : 'text-muted-foreground hover:bg-grass-2/60 hover:text-green-brand',
  )
}

function mobileNavLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'rounded-none px-3 py-2 text-[15px] font-medium no-underline transition-colors',
    isActive
      ? 'bg-grass-2 font-bold text-green-darkest'
      : 'text-muted-foreground hover:bg-grass-2/60 hover:text-green-brand',
  )
}

/**
 * Guided Walkthrough out-of-modal bar (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §4.1): the active conversation's walkthrough, if it is still "live" (not
 * dismissed via "やめる", not yet fully complete). `AppLayout` reads the store
 * directly with the same `useSyncExternalStore(subscribeChatStore,
 * getChatSnapshot)` seam every other reader of it uses - no new global state.
 */
function useLiveWalkthrough(): { template: WalkthroughTemplate; state: WalkthroughState } | null {
  const chatSnapshot = useSyncExternalStore(subscribeChatStore, getChatSnapshot)
  const activeConversation = chatSnapshot.conversations.find(
    (conversation) => conversation.id === chatSnapshot.activeConversationId,
  )
  const walkthroughState = activeConversation?.walkthrough
  if (!walkthroughState || walkthroughState.dismissedAt !== null) return null
  const template = findWalkthroughTemplate(walkthroughState.templateId)
  if (!template || isWalkthroughComplete(template, walkthroughState)) return null
  return { template, state: walkthroughState }
}

export function AppLayout() {
  const { state, logout } = useAuth()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  // Confirmation modal guarding against accidental logout. Its open state is
  // tracked independently of auth state: `logout()` flips state.status to
  // 'unauthenticated' synchronously, so tying the close to that branch would
  // be timing-dependent.
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false)
  const liveWalkthrough = useLiveWalkthrough()
  const scrolled = useScrolled()

  /* The top page is the full-width landing of the theme (hero band, TLD band,
     price grid, CTA panel), so it lays out its own containers; every other
     screen keeps the narrow reading column the shell provides. */
  const isLanding = location.pathname === '/'
  /* かんたんモードは左に縦型ステッパーを置く2カラムなので、シェルの狭い読み
     カラム（max-w-3xl）だと収まらない。横幅だけ自前に譲り、背景の草の帯は
     他の内部画面と同じものを引き継ぐ。 */
  const isEasyMode = location.pathname.startsWith('/easy')

  /* バーに出るのは「行き先」だけ。モードの切り替え（通常 / かんたん）は
     トップページ本文の `EasyModeSwitch` が持つ（2026-08-28）— バーに切り替えを
     混ぜると、行き先リンクと同じ 1 組の選択肢に見えて、いま自分がどちらの
     モードに居るのかがかえって読めなくなった。

     「ドメイン検索」もここには出さない。同じ `/` へ行くブランドリンクが
     すぐ左にあるので、隣り合う 2 つが同じ行き先という二重になる。
     結果、未ログインのときバーに出す行き先は 1 つも無い。

     かんたんモードの現在地バッジ＋「通常モードに戻る」の出口（issue #91）も
     一時期ここに出していたが、バーに通常/かんたんの文字が並ぶこと自体が
     余計だ、という利用者の指摘で削除した（2026-08-28）。戻さないこと。
     通常モードへはブランドリンク（トップ = 下書き破棄つきのやり直し起点）と
     フッターから戻れる。 */
  const links =
    state.status === 'authenticated'
      ? [
          // FIG.9: ログイン状態で出るマイページ導線。保有ドメインの管理はここ
          // 1つに集約している（/dashboard は製品画面ではないのでナビには
          // 出さない — フッターの「認証の動作確認」から辿れる）。
          { to: '/mypage', label: 'マイページ' },
        ]
      : []

  /* ログイン／会員登録はナビの並びではなくヘッダー右端の「入口」。角を落とした
     四角い箱を1つに継いで、丸いピル一色のページの中で唯一角張ったブロックに
     する（DESIGN_SYSTEM.md のピル規定に対する、意図的な1箇所の例外）。
     ナビ本体には出さない — 同じ名前のリンクがヘッダーに2つあると、
     `header.getByRole('link', { name: 'ログイン' })` が曖昧になる。 */
  const authLinks =
    state.status === 'authenticated'
      ? []
      : [
          { to: '/login', label: 'ログイン' },
          { to: '/signup', label: '会員登録' },
        ]

  return (
    <TooltipProvider delayDuration={200}>
      {/* ルート遷移のたびにページ先頭へ戻す（issue #83）。シェルはすべてのルートを
          包んでいるので、ここに 1 つ置けば通常モードもかんたんモードも同じ規則で
          揃う — 画面ごとに書くと必ず書き漏らしが出る。 */}
      <ScrollToTop />
      <div className="flex min-h-screen flex-col bg-background">
        <header
          className={cn(
            'sticky top-0 z-40 border-b border-border bg-header-surface shadow-[0_6px_18px_-18px_rgb(23_60_40_/_45%)] transition-[background-color,box-shadow] duration-200',
            scrolled &&
              'bg-[var(--header-surface-translucent)] shadow-[0_10px_24px_-18px_rgb(23_60_40_/_60%)] backdrop-blur-md backdrop-saturate-150',
          )}
        >
          <div className="mx-auto flex w-full max-w-[1400px] items-center gap-2 px-4 py-3 sm:px-7">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label="メニューを開く"
                >
                  <Menu className="size-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="bg-grass-1 data-[side=left]:w-72">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2.5 text-left text-[17px] font-bold tracking-tight text-green-darkest">
                    <BrandMark className="size-6" />
                    ゼロからドメイン
                  </SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1 px-4">
                  {/* デスクトップのバーと同じ中身（行き先だけ）。 */}
                  {links.map((link) => (
                    <NavLink
                      key={link.to}
                      to={link.to}
                      className={mobileNavLinkClass}
                      onClick={() => setMenuOpen(false)}
                    >
                      {link.label}
                    </NavLink>
                  ))}
                  {/* ヘッダー右端の四角い入口は狭い画面では畳まれるので、
                      その分をここに出す（デスクトップと同じ行き先）。 */}
                  {authLinks.map((link) => (
                    <NavLink
                      key={link.to}
                      to={link.to}
                      className={mobileNavLinkClass}
                      onClick={() => setMenuOpen(false)}
                    >
                      {link.label}
                    </NavLink>
                  ))}
                  {/* §13.4 Phase 2 / §13.5: same entry point, mobile nav.
                      `showLabel` because the launcher's own label gate is
                      `min-[820px]:` and this sheet only exists below `md` -
                      the gate can never fire here, so without it the row is a
                      bare glyph under three text rows. The className matches
                      `mobileNavLinkClass`'s geometry (full-width, left
                      aligned, same 12px inset and same 37.4px row box) so it
                      lines up with the links above it. `py-[7px]`, not
                      `py-2`: `buttonVariants` carries a 1px transparent
                      border that the `<a>` rows do not, and `leading-[1.4286]`
                      is the rows' own computed 21.43px line box - together
                      they reproduce the links' measured 37.42px height
                      exactly. */}
                  <AssistantLauncher
                    variant="icon"
                    showLabel
                    className="h-auto w-full justify-start px-3 py-[7px] text-[15px] leading-[1.4286]"
                  />
                </nav>
              </SheetContent>
            </Sheet>

            <Link
              to="/"
              className="flex shrink-0 items-center gap-2 font-heading text-[18px] font-bold tracking-tight whitespace-nowrap text-green-darkest no-underline transition-opacity hover:text-green-darkest hover:opacity-85"
            >
              <BrandMark className="size-8" />
              ゼロからドメイン
            </Link>

            <nav className="ml-2 hidden items-center gap-2 md:flex">
              {links.map((link) => (
                <NavLink key={link.to} to={link.to} className={navLinkClass}>
                  {link.label}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-2.5">
              {/* §13.4 Phase 2 / §13.5: the assistant reachable from every page. */}
              <AssistantLauncher variant="icon" />
              {/* The three-state machine, visible at all times for verification.
                  Below md it is hidden the same way the nav is: measured at a
                  500px viewport, brand + this cluster came to 580px and the
                  whole page scrolled sideways. It stays in the DOM (the flow
                  tests assert the readout with toBeInTheDocument), and on a
                  narrow screen the ログアウト button already reports the same
                  authenticated/anonymous split. */}
              <Badge
                variant="outline"
                className="hidden gap-1.5 border-transparent bg-grass-1 font-medium text-muted-foreground md:inline-flex"
              >
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOTS[state.status])}
                />
                AuthContext: {STATUS_LABELS[state.status]}
              </Badge>
              {state.status === 'authenticated' ? (
                /* 狭い画面ではアイコンだけにする。ブランド名（180px）＋この
                   ボタン（112px）＋ハンバーガー＋相談アイコンで 390px の画面が
                   24px 横スクロールしていた（実測 2026-08-27）。読み上げ名は
                   sr-only のラベルが常に持つので、名前で引くテストは変わらない。 */
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-sm:px-2.5"
                  onClick={() => setLogoutDialogOpen(true)}
                >
                  <LogOut aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">ログアウト</span>
                </Button>
              ) : (
                /* 2つの箱を1pxだけ重ねて継ぎ、角丸ゼロの1ブロックに見せる。
                   狭い画面では畳んでハンバーガー内のナビに任せる。 */
                <div className="hidden items-center md:flex">
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-none border-green-brand/35 px-4 text-green-deep hover:bg-grass-2 hover:text-green-darkest"
                  >
                    <Link to="/login">ログイン</Link>
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    className="-ml-px h-9 rounded-none border-primary px-4"
                  >
                    <Link to="/signup">会員登録</Link>
                  </Button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Guided Walkthrough progress, visible even while the assistant
            modal is closed (plan §4.1) - renders nothing at all when there is
            no live walkthrough, so this never affects a page that has not
            started one (see AssistantLauncher.test.tsx's regression test). */}
        {liveWalkthrough ? (
          <div className="border-b border-border bg-grass-1 px-4 py-1.5 sm:px-7">
            <div className="mx-auto w-full max-w-[1400px]">
              <AssistantLauncher
                variant="compact"
                walkthroughTemplate={liveWalkthrough.template}
                walkthroughState={liveWalkthrough.state}
              />
            </div>
          </div>
        ) : null}

        {/* Inner screens carry the grass band down from the header so they read
            as the same sheet of paper as the landing (the landing paints its
            own hero gradient, so it opts out). */}
        <div
          className={cn(
            'flex w-full flex-1 flex-col',
            isLanding
              ? ''
              : 'bg-[linear-gradient(180deg,var(--grass-1)_0,color-mix(in_oklab,var(--grass-1)_35%,var(--paper))_120px,var(--paper)_320px)]',
          )}
        >
          <main
            className={cn(
              'flex w-full flex-1 flex-col',
              isLanding || isEasyMode ? '' : 'mx-auto max-w-3xl px-4 pt-8 pb-24 sm:px-6 lg:pt-10',
            )}
          >
            <Outlet />
          </main>
        </div>

        <footer className="bg-paper-2 px-4 py-12 text-[13px] text-muted-foreground sm:px-7">
          <div className="mx-auto w-full max-w-[1400px]">
            <div className="mb-8 grid grid-cols-2 gap-7 lg:grid-cols-4">
              {FOOTER_COLUMNS.map((column) => (
                <div key={column.heading}>
                  <h2 className="mb-2.5 text-[13px] font-bold text-foreground">{column.heading}</h2>
                  <ul className="m-0 list-none space-y-1.5 p-0">
                    {column.links.map((link) => (
                      <li key={link.label}>
                        <Link to={link.to} className="text-muted-foreground no-underline hover:underline">
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <div>
                <h2 className="mb-2.5 text-[13px] font-bold text-foreground">このサービスについて</h2>
                <ul className="m-0 list-none space-y-1.5 p-0 text-muted-foreground">
                  <li>レジストリ Kitaqsign（.com / .net / .org / .info）</li>
                  <li>レジストリ Kitaqnic（その他18種）</li>
                  <li>
                    <Link
                      to="/legal/third-party-licenses"
                      className="text-muted-foreground no-underline hover:underline"
                    >
                      第三者ライセンス
                    </Link>
                  </li>
                </ul>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 border-t border-border pt-5 text-xs text-ink-faint">
              <span>ゼロからドメイン — GMOインターネットグループ 学生ハッカソン TeamC</span>
              <span>料金・レジストリは演習用のダミーデータです。</span>
            </div>
          </div>
        </footer>

        {shouldUseMocks() ? <MockControlPanel /> : null}
      </div>
      {supportsToaster ? <Toaster /> : null}
      <LogoutConfirmDialog
        open={logoutDialogOpen}
        onOpenChange={setLogoutDialogOpen}
        onConfirm={() => {
          // Close first, then log out - see the note on `logoutDialogOpen`.
          setLogoutDialogOpen(false)
          void logout()
        }}
      />
    </TooltipProvider>
  )
}
