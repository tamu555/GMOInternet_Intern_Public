/**
 * ドメイン検索 = トップページ (docs/api-flow-diagrams.html FIG.1, left half).
 *
 * Visual design: design_theme/theme-04-3-wakakusa.html (やわらか若草型). The
 * landing state reproduces that page section for section — hero + 安いTLDの帯
 * + 22TLDの料金 + 3つの安心 + 結果見本 + CTA — because its whole job is to
 * take the fear out of a first search. Deep green stays on type, buttons and
 * small marks; the surfaces are 生成りの紙 and the two pale grass tints.
 *
 * 結果見本 と CTA のあいだに、テーマにはない節がひとつ増えている
 * (`LandingFeatures.tsx`): かんたんモード・AIアシスタント・つなぐ(DNS)の3つ。
 * 上半分が「検索する前の不安」に答える節ばかりなのに対して、この節は
 * 「検索したあと、取ったあとはどうなるのか」に答える。同じ理由で 22TLDの料金は
 * 4列のカードから1行1TLDの一覧に畳んである — 説明が増えたぶん、料金表が
 * ページの真ん中を900px占め続けるわけにいかない。
 *
 * PUBLIC route on purpose: searching, availability, pricing and the
 * rule-based suggestions must all work without a login. Only the application
 * flow onwards (/domains/new) is protected - the route guard sends an
 * unauthenticated user to /login and returnTo brings them straight back,
 * query string included.
 *
 * There is no TLD picker: a search always covers every supported TLD (the
 * fetched list, spec §4.3) and the per-TLD choice happens on the result
 * table, where available TLDs are selected into a cart ("選択した商品") and
 * "次へ進む" hands the selection to the application form.
 *
 * The executed search lives in the URL (?q=<label>), making it the single
 * source of truth: a reload, a shared link, or the login round-trip all
 * restore the same results by re-running the search from the query
 * parameter. Submitting the form writes the URL and bumps an attempt counter;
 * an effect keyed on both performs the actual search. The counter is what
 * makes "the same query, once more" a real submission — the URL cannot say it
 * twice, and after a registry outage asking again is the whole point.
 *
 *   POST /api/domains/search -> per-TLD result, one of 3 states (spec §6.7):
 *     available | taken (2302) | unknown (registry unreachable - never shown
 *     as "使用中", see DomainSelectTable)
 *
 * A search that fails OUTRIGHT (every registry unreachable before any circuit
 * opened, so the callable throws instead of answering per-TLD) still reaches
 * the result screen: it renders the reason and a 再試行 button in place of the
 * table. Falling back to the untouched landing page was the old behaviour and
 * read as an unresponsive 検索する button.
 *
 * When nothing searched for is available, a rule-based suggestion pass runs
 * (spec §6.2.4, no AI) and only shows candidates whose availability was
 * itself re-checked against the search API (suggestionEngine.ts).
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { CloudOff, Loader2, RefreshCw } from 'lucide-react'
import { StatusBanner } from '../../components/StatusBanner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AssistantLauncher } from '../assistant/AssistantLauncher'
import { LOGIN_PATH } from '../../config'
import { useAuth } from '../../auth/useAuth'
import { saveReturnTo } from '../../auth/returnTo'
import { messageForError } from '../../api/apiError'
import { searchDomains, type DomainSearchRequest, type DomainSearchResultItem } from '../../api/domainsSearchApi'
import { addDomainWatch, fetchDomainWatches, isActiveWatch } from '../../api/watchesApi'
import { DomainSearchForm } from './DomainSearchForm'
import { DomainSelectTable, TLD_GRID, TldCell } from './DomainSelectTable'
import {
  maintenanceNotice,
  messageForSearchError,
  SEARCH_FAILED_HEADING,
  SEARCH_RETRY_BUTTON_LABEL,
  TLDS_FALLBACK_NOTICE,
  UNAVAILABLE_NOTICE,
  watchRegisteredNotice,
} from './domainMessages'
import { SelectionCart } from './SelectionCart'
import { getVerifiedSuggestions, type CandidateSuggestion } from './suggestionEngine'
import { SuggestionList } from './SuggestionList'
import { formatYen, getTldMeta, getTldPricingOrDefault } from './tldData'
import { useSupportedTlds } from './useSupportedTlds'
import { normalizeDomainLabel, validateDomainLabel, type DomainSearchFormErrors } from './validation'
import { HeroTree } from './HeroTree'
import { EASY_JOURNEY_PARTS } from '../easy/easyJourney'
import { EasyModeSwitch } from '../easy/EasyModeSwitch'
import { clearEasyDrafts } from '../easy/easyStorage'
import { LandingFeatures } from './LandingFeatures'

/**
 * キャッチコピーの「ドメイン」に付けるツールチップの説明文。かんたんモードの
 * 全体図（easyJourney）の①と同じ文 — ここで書き直すと、同じ用語の説明が
 * アプリ内で2種類になる。
 */
const DOMAIN_TERM_DESCRIPTION =
  EASY_JOURNEY_PARTS.find((part) => part.id === 'domain')?.body ?? ''

/** Query-parameter name — part of the shareable-URL contract (README). */
const LABEL_PARAM = 'q'

/** The theme's page gutter: a 1400px column with a 28px inset. */
const WRAP = 'mx-auto w-full max-w-[1400px] px-4 sm:px-7'

/**
 * ヒーローだけの、一段狭い段（2026-08-28、利用者の指摘）。段が1400pxに広がって
 * から、見出し〜検索フォームが画面の左端、木が右端に離れて、中央が空いて
 * 見えていた。ヒーローの中身は2カラム合わせて1200pxもあれば足りるので、
 * この節だけ狭い段に載せて全体を中央へ寄せる。背景の帯は full-bleed のまま。
 */
const HERO_WRAP = 'mx-auto w-full max-w-[1240px] px-4 sm:px-7'

/**
 * ランディングの節の縦リズム。以前は節ごとに py-16 lg:py-20 (64/80px) で、
 * 中身の少ない節ほど間延びして見えていた。1つの値に固定してあるので、
 * リズムを変えるときはここ1箇所で足りる。
 */
const SECTION_Y = 'py-12 lg:py-16'
/** 上の節が下パディングを持っている場合の、続きの節（下だけ）。 */
const SECTION_PB = 'pb-12 lg:pb-16'

function needsSuggestions(results: DomainSearchResultItem[]): boolean {
  const hasAvailable = results.some((result) => result.state === 'available')
  const hasTaken = results.some((result) => result.state === 'taken')
  // Every TLD unavailable to *check* (a full outage) is not "no availability" -
  // fabricating alternatives on top of a communication failure would be worse
  // than showing nothing, so suggestions require at least one confirmed "taken".
  return hasTaken && !hasAvailable
}

/** Parses the URL into a searchable label; null = no (valid) search in the URL. */
function labelFromParams(params: URLSearchParams): string | null {
  const label = normalizeDomainLabel(params.get(LABEL_PARAM) ?? '')
  if (!label || validateDomainLabel(label)) return null
  return label
}

function requestKeyOf(request: DomainSearchRequest | null): string | null {
  return request ? `${request.label}|${request.tlds.join(',')}` : null
}

/**
 * Identifies one EXECUTION of a search, where `requestKeyOf` only identifies
 * what is being searched for. Pressing 検索する / 再検索 / 再試行 bumps
 * `attempt`, so an unchanged query still produces a new run key and the effect
 * below fires again — the URL alone cannot express "ask once more", and after
 * an outage that is exactly what the user is trying to say.
 *
 * The two keys are kept separate on purpose: the results already on screen are
 * matched by `requestKeyOf` only, so a retry does not tear the table down and
 * drop the visitor back onto the landing page while the answer is in flight.
 */
function runKeyOf(request: DomainSearchRequest | null, attempt: number): string | null {
  const key = requestKeyOf(request)
  return key === null ? null : `${key}|${attempt}`
}

/** The one-word badge the theme prints under a price, or nothing. */
function flagForTld(tld: string): string | null {
  if (tld === '.com') return '人気No.1'
  const meta = getTldMeta(tld)
  if (meta?.requiresHttps) return '常時HTTPS必須'
  if (meta?.premium) return 'プレミアム'
  return null
}

/** One executed search: results plus the (async) suggestion pass that may follow. */
type SearchOutcome = {
  /** What was searched for (`requestKeyOf`) - decides what stays on screen. */
  key: string
  /** Which execution answered (`runKeyOf`) - decides whether one is still running. */
  runKey: string
  /** null = the search itself failed; `error` then carries the reason. */
  results: DomainSearchResultItem[] | null
  error: string | null
  /** Announced end of a maintenance window, when one TLD's registry is in one. */
  maintenanceUntil: string | null
  suggestions: CandidateSuggestion[] | null
  suggestionsLoading: boolean
}

/**
 * ヒーローのイラスト。保有件数で育ち、1件が1枚の葉になって実る木（HeroTree）。
 * aria-hidden は HeroTree 自身が状態に応じて出し分けるので、ここでは付けない
 * — TLDの木は装飾だが、保有ドメインの木は読み上げるべき中身を持っている。
 */
function HeroArt() {
  // lg では列が440pxしかないので、木だけ一回り大きく描いて -mr-6 ではみ出させる。
  // xl からはヒーロー専用の狭い段（HERO_WRAP）が全体を中央へ寄せるので、
  // はみ出しは打ち切るだけでよい（xl:mr-0）。右端に貼りついて見える問題は
  // 段の狭さが解決している（2026-08-28）。
  return (
    <div className="hidden lg:-mr-6 lg:block xl:mr-0">
      <HeroTree className="ml-auto w-full" />
    </div>
  )
}


export function DomainSearchPage() {
  const idPrefix = useId()

  /* トップページ＝やり直しの起点（2026-08-28）。ここへ戻ってきた時点で、
     かんたんモードの入力途中の下書きは捨てる。残しておくと、次に「かんたん」を
     開いた人が前回の続き（覚えていない目的や名前）から再開させられる。
     注文発行済みの下書きだけは残る — 理由は clearEasyDrafts の説明を見ること。
     マウント時に 1 回だけ。`/?q=` の検索は同じ画面の中の遷移なので効かない。 */
  useEffect(() => {
    clearEasyDrafts()
  }, [])

  const { state: authState } = useAuth()
  const { tlds, loading: tldsLoading, usingFallback } = useSupportedTlds()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()

  // A search always spans every supported TLD - there is no TLD picker.
  const request = useMemo<DomainSearchRequest | null>(() => {
    const requestedLabel = labelFromParams(searchParams)
    if (!requestedLabel || tldsLoading || tlds.length === 0) return null
    return { label: requestedLabel, tlds }
  }, [searchParams, tldsLoading, tlds])
  const requestKey = requestKeyOf(request)

  const [label, setLabel] = useState(() => searchParams.get(LABEL_PARAM) ?? '')
  const [fieldErrors, setFieldErrors] = useState<DomainSearchFormErrors>({})
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null)
  /**
   * How many times a search has been ASKED for, counting re-submissions of an
   * unchanged query (see `runKeyOf`). Never part of the URL: it says "again",
   * which is not something a shared link should replay.
   */
  const [attempt, setAttempt] = useState(0)
  const runKey = runKeyOf(request, attempt)

  // The cart deliberately survives re-searches: it may mix domains collected
  // across several labels, exactly like a shop basket.
  const [selected, setSelected] = useState<string[]>([])

  // 空き待ち通知 (docs/仕様/domain-watch.md): which domains the signed-in
  // member already watches, so their cells say 登録済み instead of offering
  // the button again.
  const [watched, setWatched] = useState<string[]>([])
  const [watchNotice, setWatchNotice] = useState<string | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)

  useEffect(() => {
    if (authState.status !== 'authenticated') return
    const controller = new AbortController()
    // Best-effort: a failure only loses the 登録済み marks, and registering
    // again is answered idempotently by the backend anyway.
    void fetchDomainWatches(controller.signal)
      .then((watches) => {
        setWatched(watches.filter(isActiveWatch).map((watch) => watch.domainName))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [authState.status])

  async function handleWatch(domain: string) {
    if (authState.status !== 'authenticated') {
      // Same hand-off as RequireAuth: record where the member was heading,
      // send them to login. The search URL (?q=) restores the results.
      const returnTo = `${location.pathname}${location.search}`
      saveReturnTo(returnTo)
      navigate(LOGIN_PATH, { state: { returnTo } })
      return
    }
    setWatchError(null)
    try {
      await addDomainWatch(domain)
      setWatched((current) => (current.includes(domain) ? current : [...current, domain]))
      setWatchNotice(watchRegisteredNotice(domain))
    } catch (error) {
      setWatchNotice(null)
      setWatchError(messageForError(error))
    }
  }

  // Adjust-during-render: when the URL changes underneath us (back/forward,
  // returning from the login round-trip), reflect the executed search back
  // into the form control.
  const [syncedKey, setSyncedKey] = useState(requestKey)
  if (syncedKey !== requestKey) {
    setSyncedKey(requestKey)
    if (request) setLabel(request.label)
  }

  useEffect(() => {
    if (!request) return
    const key = requestKeyOf(request) as string
    const currentRunKey = runKeyOf(request, attempt) as string
    const controller = new AbortController()

    async function run() {
      if (!request) return
      try {
        const response = await searchDomains(request, controller.signal)
        const wantsSuggestions = needsSuggestions(response.results)
        setOutcome({
          key,
          runKey: currentRunKey,
          results: response.results,
          error: null,
          maintenanceUntil: response.maintenanceUntil ?? null,
          suggestions: null,
          suggestionsLoading: wantsSuggestions,
        })
        if (!wantsSuggestions) return
        let verified: CandidateSuggestion[] = []
        try {
          verified = await getVerifiedSuggestions({
            label: request.label,
            requestedTlds: request.tlds,
            supportedTlds: request.tlds,
          })
        } catch {
          // Suggestion verification is best-effort; an empty list is honest.
        }
        if (!controller.signal.aborted) {
          setOutcome({
            key,
            runKey: currentRunKey,
            results: response.results,
            error: null,
            maintenanceUntil: response.maintenanceUntil ?? null,
            suggestions: verified,
            suggestionsLoading: false,
          })
        }
      } catch (error) {
        if (controller.signal.aborted) return
        // A failed search is still an ANSWERED search: recording the outcome
        // is what puts the result screen on the page with the reason on it,
        // instead of leaving the visitor on an unchanged landing page.
        setOutcome({
          key,
          runKey: currentRunKey,
          results: null,
          error: messageForSearchError(error),
          maintenanceUntil: null,
          suggestions: null,
          suggestionsLoading: false,
        })
      }
    }

    void run()
    return () => controller.abort()
  }, [request, attempt])

  /**
   * The outcome belonging to the search currently in the URL, if it arrived.
   * Matched on `key`, not `runKey`, so a retry of the same query keeps the
   * screen it is retrying from.
   */
  const current = outcome && outcome.key === requestKey ? outcome : null
  const searchInFlight = runKey !== null && outcome?.runKey !== runKey

  /** Re-runs the search already in the URL - the 再試行 button after a failure. */
  function retrySearch() {
    setAttempt((value) => value + 1)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const normalizedLabel = normalizeDomainLabel(label)
    setLabel(normalizedLabel)

    const labelError = validateDomainLabel(normalizedLabel)
    setFieldErrors(labelError ? { label: labelError } : {})
    if (labelError) return

    // Writing the URL *is* the submission - the effect above runs the search.
    // An unchanged query writes the same URL, which is no navigation at all,
    // so the attempt counter is what actually re-runs it: pressing the button
    // must always ask the registry again (the previous answer may have been a
    // failure the user is now retrying). `replace` on that path keeps repeated
    // retries from stacking identical history entries behind the back button.
    const sameQuery = searchParams.get(LABEL_PARAM) === normalizedLabel
    setSearchParams({ [LABEL_PARAM]: normalizedLabel }, sameQuery ? { replace: true } : undefined)
    setAttempt((value) => value + 1)
  }

  function toggleSelected(domain: string) {
    setSelected((currentSelection) =>
      currentSelection.includes(domain)
        ? currentSelection.filter((value) => value !== domain)
        : [...currentSelection, domain],
    )
  }

  const heroFieldId = `${idPrefix}-domain-label`

  /** Every served TLD with its price (default-priced when unlisted), registry order. */
  const pricedTlds = useMemo(
    () => tlds.map((tld) => ({ tld, pricing: getTldPricingOrDefault(tld) })),
    [tlds],
  )

  /** The theme's 帯: the five cheapest first years, renewal always beside it. */
  const cheapestTlds = useMemo(
    () =>
      [...pricedTlds]
        .sort(
          (a, b) =>
            a.pricing.firstYearYen - b.pricing.firstYearYen ||
            a.pricing.renewalYearYen - b.pricing.renewalYearYen,
        )
        .slice(0, 5),
    [pricedTlds],
  )

  // Registry judged unreachable (spec §6.9): the affected TLDs stay in the
  // table (marked ⏳, not selectable) and this banner says why, once, above.
  const unavailableActive = Boolean(
    current?.results?.some((result) => result.state === 'unavailable'),
  )
  // Registry-announced maintenance: same treatment (🔧), but this banner may
  // say メンテナンス and name the announced end when the registry gave one.
  const maintenanceActive = Boolean(
    current?.results?.some((result) => result.state === 'maintenance'),
  )
  // A failed search is deliberately NOT a banner: it is the whole content of
  // the result screen below, where it can carry the 再試行 button next to the
  // reason. Repeating the same sentence in a band above would only make the
  // screen say it twice.
  const hasBanner =
    usingFallback || unavailableActive || maintenanceActive || Boolean(watchNotice) || Boolean(watchError)
  const banners = (
    <>
      {usingFallback ? <StatusBanner tone="info">{TLDS_FALLBACK_NOTICE}</StatusBanner> : null}
      {maintenanceActive ? (
        <StatusBanner tone="info">{maintenanceNotice(current?.maintenanceUntil ?? null)}</StatusBanner>
      ) : null}
      {unavailableActive ? <StatusBanner tone="info">{UNAVAILABLE_NOTICE}</StatusBanner> : null}
      {watchNotice ? <StatusBanner tone="success">{watchNotice}</StatusBanner> : null}
      {watchError ? <StatusBanner tone="error">{watchError}</StatusBanner> : null}
    </>
  )

  /* One stable root for both states: the notice band keeps the same position
     in the tree across the landing -> results switch, so a banner that was
     already on screen is never torn down and remounted mid-search.

     The result screen is owned by "a search was ANSWERED", not by "a search
     succeeded". A full outage (every registry unreachable, so `searchDomains`
     threw instead of answering per-TLD) leaves `current.results` null, and
     gating this on the results alone kept the landing page on screen exactly
     as it was - pressing 検索する looked like it did nothing at all. */
  const results =
    current ? (
      <div className={`${WRAP} space-y-6 pt-6 pb-24`}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight">ドメイン検索</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {current.results
                ? `「${request?.label ?? label}」を、対応する${current.results.length}のTLDすべてで確認しました。`
                : `「${request?.label ?? label}」の空き状況は、どのTLDも確認できませんでした。`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <EasyModeSwitch />
            {authState.status === 'authenticated' ? (
              <Button variant="outline" size="sm" asChild>
                {/* 保有ドメインの管理画面は「マイページ」1つに統一している
                    （「管理画面」「ダッシュボード」と呼び分けない）。 */}
                <Link to="/mypage">マイページへ</Link>
              </Button>
            ) : null}
          </div>
        </header>

        {/* 再検索は結果の *上*。一覧は全TLD分あるので、下に置くと「名前を変え
            てもう一度」という最も多い次の操作が、最も遠い場所になってしまう。 */}
        <Card>
          <CardContent>
            <DomainSearchForm
              idPrefix={`${idPrefix}-research`}
              variant="research"
              label={label}
              onLabelChange={setLabel}
              labelError={fieldErrors.label}
              disabled={searchInFlight}
              onSubmit={handleSubmit}
            />
          </CardContent>
        </Card>

        {current.results ? (
          <>
            <section className="space-y-4">
              <h2 className="text-lg font-semibold tracking-tight">ご希望のドメインを選択してください</h2>
              <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
                <Card>
                  <CardContent>
                    <DomainSelectTable
                      results={current.results}
                      selected={selected}
                      onToggle={toggleSelected}
                      watched={watched}
                      onWatch={(domain) => void handleWatch(domain)}
                    />
                  </CardContent>
                </Card>
                <SelectionCart selected={selected} onRemove={toggleSelected} onClear={() => setSelected([])} />
              </div>
            </section>

            {needsSuggestions(current.results) ? (
              <section>
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2>似ている候補</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {current.suggestionsLoading ? (
                      <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        候補を確認しています…
                      </p>
                    ) : (
                      <SuggestionList candidates={current.suggestions ?? []} />
                    )}
                  </CardContent>
                </Card>
              </section>
            ) : null}
          </>
        ) : (
          /* 検索そのものが失敗したとき。◯/✕/？ の一覧は出せないので、表の
             代わりにこの1枚が結果になる — 何も起きなかったように見せない、
             というのがこの節の唯一の役目。 */
          <section className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">{SEARCH_FAILED_HEADING}</h2>
            <Card>
              <CardContent className="flex flex-col items-start gap-4">
                <p className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
                  <CloudOff className="mt-0.5 size-5 shrink-0 text-ink-faint" aria-hidden="true" />
                  <span role="alert" className="max-w-[46em]">
                    {current.error}
                  </span>
                </p>
                {/* 同じ条件で引き直すだけのボタン。時間で勝手に引き直す仕掛けは
                    意図的に置かない: 画面を開いたままにしている人の代わりに、
                    本人が押していないレジストリ問い合わせを繰り返すことになる。
                    復旧の確認は、この再試行1つに任せる。 */}
                <Button variant="outline" onClick={retrySearch} disabled={searchInFlight}>
                  {searchInFlight ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                  {SEARCH_RETRY_BUTTON_LABEL}
                </Button>
              </CardContent>
            </Card>
          </section>
        )}

        {/* §13.4: reachable after a search too, not just on the landing state
            below. The "research" search form that used to sit here was removed
            on main by the TLD-grid redesign; the assistant entry point is kept
            because a user who did not find what they wanted in the results is
            exactly who needs it. */}
        <section>
          <AssistantLauncher variant="cta" />
        </section>
      </div>
    ) : null

  return (
    <div>
      {hasBanner ? <div className={`${WRAP} space-y-4 pt-6`}>{banners}</div> : null}
      {results}
      {results ? null : (
        <>
      {/* ── ヒーロー ───────────────────────────────────────────────── */}
      <section className="relative flex items-center overflow-hidden bg-[linear-gradient(180deg,var(--grass-1)_0%,var(--grass-1)_58%,var(--paper)_100%)] py-12 lg:py-16">
        <span className="leaf -top-22 -left-40 h-[360px] w-[520px] -rotate-12 bg-grass-2 opacity-55" />
        <span className="leaf -right-30 -bottom-20 h-[270px] w-[380px] rotate-[24deg] bg-grass-2 opacity-[.42]" />

        {/* 木の列は 520px — 1240px の段でこれ以上広げると、左列が 48px 見出し
            の必要幅（〜585px）を割って3行に折れる。 */}
        <div className={`${HERO_WRAP} relative z-1 grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_520px]`}>
          <div>
            {/* キャッチコピーの上に小さな前置きは出さない（テーマ通り）。
                h1 は残すが視覚的には見せない — 見出し階層とテスト契約
                （heading ドメイン検索）は保ったまま、画面からは消す。
                書体は他の節の見出しと同じ丸ゴシック。@layer base の
                h1-h3 ルールは <p> には効かないので font-heading で明示する
                （Zen Maru Gothic は 500/700/900 を読み込み済み = font-black 可）。 */}
            <h1 className="sr-only">ドメイン検索</h1>
            {/* 「名前」→「ドメイン」（2026-08-28、利用者の指示）。カーソルを
                合わせる（キーボードならフォーカス）と説明が出る。dns/TermTooltip の
                点線下線＋?は、48pxの見出しに重ねるとうるさい、という指摘で外して
                ある（同日）— 飾りは付けず、語そのものだけをトリガにする。
                トリガは必ず button — キーボードでもフォーカスで開くため
                （TermTooltip.tsx と同じ理由）。 */}
            <p className="mb-5 font-heading text-[31px] leading-[1.3] font-black text-balance sm:text-[48px]">
              ほしい
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="ドメインとは"
                    className="rounded-sm font-heading font-black focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    ドメイン
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[24em] leading-relaxed">{DOMAIN_TERM_DESCRIPTION}</TooltipContent>
              </Tooltip>
              、
              <br />
              空いているか見てみよう。
            </p>

            {/* 初心者にいちばん効く事実（ログイン不要・全TLD一括）は、これまで
                ページ最下部のCTAにしか書いていなかった。最初の画面で言い切る。 */}
            {/* 節ごとに inline-block で包むのは、`text-balance` が「対／応」のような
                熟語の途中で折り返していたため。ブラウザはまず span と span の
                あいだで折り、収まらないときだけ span の内側で折る。 */}
            <p className="mb-6 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
              <span className="inline-block">ログインもカード登録も要りません。名前を入れるだけで、</span>
              <span className="inline-block">対応するすべてのTLDの空きと料金をまとめて確認できます。</span>
            </p>

            {/* 通常モード / かんたんモード の切り替え。ここが唯一の入口ではなく
                ヘッダーとフッターにも導線があるが、初めての人が最初に見るのは
                ここなので、検索フォームの真上に置く。 */}
            <EasyModeSwitch className="mb-5" />

            <DomainSearchForm
              idPrefix={idPrefix}
              label={label}
              onLabelChange={setLabel}
              labelError={fieldErrors.label}
              disabled={searchInFlight}
              onSubmit={handleSubmit}
            />

            {/* ヒーローに置いていた「マイページへ」ボタンは削除（2026-08-28、
                利用者の指摘）。ログイン後の入口はヘッダーのナビ「マイページ」
                1 か所に集約する。検索結果画面のヘッダーの「マイページへ」は別物
                で、あちらは残っている。 */}

            {/* §13.4 mock: directly below the hero search field block.
                AssistantLauncher(cta) は既定で左揃え・インラインなので、
                ここでは余白と行長だけを与える。 */}
            <div className="mt-7 max-w-[560px]">
              <AssistantLauncher variant="cta" />
            </div>
          </div>

          <HeroArt />
        </div>
      </section>

      {/* ── 帯 : いま初年度が安いTLD ────────────────────────────────── */}
      {cheapestTlds.length > 0 ? (
        <section className="relative overflow-hidden bg-grass-2 py-9">
          <span className="leaf -top-15 -right-17 h-[210px] w-[300px] rotate-[16deg] bg-card opacity-30" />
          <div className={`${WRAP} relative z-1`}>
            <div className="mb-4.5 flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-[22px] font-black">いま初年度が安いTLD</h2>
              <a href="#tlds" className="text-[13.5px] font-bold text-green-brand underline underline-offset-4">
                料金の一覧を見る →
              </a>
            </div>
            <ul className="grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-5">
              {cheapestTlds.map(({ tld, pricing }) => (
                <li key={tld} className="rounded-lg bg-card/70 px-2 py-3.5 text-center">
                  <span className="font-en block text-[15px] font-semibold tracking-wide text-green-darkest">
                    {tld}
                  </span>
                  <span className="font-en text-sm font-semibold">{formatYen(pricing.firstYearYen)}</span>
                  <span className="font-en block text-[11px] text-ink-faint">
                    更新 {formatYen(pricing.renewalYearYen)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {/* ── 対応TLDと料金 ─────────────────────────────────────────── */}
      {pricedTlds.length > 0 ? (
        <section id="tlds" className={`scroll-mt-20 ${SECTION_Y}`}>
          <div className={WRAP}>
            <div className="mb-6">
              <h2 className="mb-2.5 text-2xl font-black sm:text-[30px]">
                対応している{pricedTlds.length}のTLDと料金
              </h2>
              {/* 行は「TLD ─ 初年度 ─ 更新」の1行に畳んであるので、どちらの
                  数字がどちらなのかを表の外で1度だけ言う。§6.2.5 のとおり
                  初年度と更新は同じ文字サイズで、太さと色だけで区別する。 */}
              <p className="max-w-[46em] text-sm leading-relaxed text-muted-foreground text-balance">
                すべて税込・1年あたり。左の濃い数字が初年度、右のうすい数字が2年目からの更新料です。初年度が安いTLDほど更新料は上がるので、必ず並べて表示しています。
              </p>
            </div>
            {/* 以前は22件を4列のカードで並べていて、この節だけで900px近く
                使っていた。カードをやめて1行1TLDに畳み、影は外側の1枚だけに
                する（テーマの「影は1種類」を22回繰り返さない）。

                ⚠️ 行の中身は左詰めの固定スロット（TLD 88px + 初年度 60px 右揃え）
                にする。以前は価格を ml-auto で行の右端へ寄せていたが、段が
                1400px に広がってからは 1 列が 440px 近くあり、TLD名と価格の間に
                200px 超の空白が走って行として読めなかった（2026-08-28、利用者の
                指摘）。スロット幅を揃えることで、列内の 22 行が表として目で
                追える。列数は xl で 4（1 列 ≈ 320px なら左詰めでも余白が出ない）。 */}
            <div className="bg-card p-2 shadow-soft sm:p-3">
              <ul className="grid list-none grid-cols-1 gap-x-4 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {pricedTlds.map(({ tld, pricing }) => {
                  const flag = flagForTld(tld)
                  return (
                    <li
                      key={tld}
                      className="flex items-baseline gap-x-3 px-3 py-2.5 whitespace-nowrap transition-colors hover:bg-grass-1"
                    >
                      <span className="font-en w-[88px] shrink-0 text-[15px] font-semibold tracking-tight text-green-brand">
                        {tld}
                      </span>
                      <span className="font-en w-[60px] shrink-0 text-right text-[13.5px] font-semibold">
                        {formatYen(pricing.firstYearYen)}
                      </span>
                      <span className="font-en text-[12.5px] text-ink-faint">
                        更新 {formatYen(pricing.renewalYearYen)}
                      </span>
                      {flag ? (
                        <span className="bg-grass-1 px-2 py-0.5 font-sans text-[10.5px] leading-tight text-green-darkest">
                          {flag}
                        </span>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
            <p className="mt-5 max-w-[60em] text-[12.5px] leading-loose text-ink-faint text-balance">
              復旧料（有効期限切れ後の取り戻し）は ¥3,300 〜 ¥6,600。.dev / .app
              はHSTSプリロード済みのため常時HTTPS化が必須です。レジストリは Kitaqsign（.com / .net / .org /
              .info）と Kitaqnic（その他18種）の2社です。料金・レジストリは演習用のダミーデータです。
            </p>
          </div>
        </section>
      ) : null}

      {/* ── 3つの安心 ──────────────────────────────────────────────── */}
      <section className={SECTION_PB}>
        <div className={WRAP}>
          <h2 className="mb-7 text-2xl font-black sm:text-[30px]">はじめてでも、つまずかないように</h2>
          <ul className="grid list-none grid-cols-1 gap-5.5 p-0 lg:grid-cols-3">
            {[
              {
                box: 'bg-grass-3',
                title: 'TLDは選ばなくていい',
                body: '名前だけ入れれば、対応するすべてのTLDに問い合わせます。「.com がだめなら次は .net」と試し直す必要はありません。',
              },
              {
                box: 'bg-sun',
                title: 'だめなときは代わりを出す',
                body: '希望がすべて埋まっていたときだけ、似た候補を出します。しかも、その場で空きを確認できたものだけを表示します。',
              },
              {
                box: 'bg-sky',
                title: '分からないときは、そう書く',
                body: 'レジストリに繋がらなかったTLDは、空きとも使用中とも書きません。◯ / ✕ / ？ を記号と文字の両方で区別します。',
              },
            ].map((item, index) => (
              <li key={item.title} className="rounded-xl bg-grass-1 px-6 py-6.5">
                <span
                  aria-hidden="true"
                  className={`mb-4 flex size-12 items-center justify-center rounded-none font-heading text-[21px] font-black ${item.box}`}
                >
                  {index + 1}
                </span>
                <h3 className="mb-1.5 text-[17.5px] font-bold">{item.title}</h3>
                <p className="text-sm leading-loose text-muted-foreground text-balance">{item.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── 結果見本 ──────────────────────────────────────────────── */}
      <section className={`relative overflow-hidden bg-paper-2 ${SECTION_Y}`}>
        <span className="leaf -bottom-27 -left-35 h-[290px] w-[420px] -rotate-[18deg] bg-grass-2 opacity-40" />
        {/* 見本は4セルしかない。TLD_GRID は auto-fill なので 1400px の段に
            そのまま置くと左4割に固まって、残りが取り残された余白に見える。
            説明と見本の2カラムにして、見本側を 520px に収める — その幅なら
            auto-fill がちょうど4トラックを作るので、セルの大きさは検索後の
            一覧と同じままになる。 */}
        <div className={`${WRAP} relative z-1 grid items-start gap-9 lg:grid-cols-[minmax(0,1fr)_520px] lg:gap-12`}>
          <div>
            <h2 className="mb-3 text-2xl font-black sm:text-[30px]">検索するとこう出ます</h2>
            {/* ◯ / ✕ / ？ の意味は結果画面にも凡例として出るが、初めての人が
                それを読むのは「もう結果が出てしまったあと」になる。先に言う。 */}
            <p className="max-w-[34em] text-sm leading-relaxed text-muted-foreground text-balance">
              名前を入れると、対応するすべてのTLDが一覧で出ます。◯ は空きあり、✕ はすでに使用中、？
              はレジストリに問い合わせできなかったTLDです。空いているものだけを選んで次に進めます。
            </p>
          </div>
          <div className="max-w-[520px]">
            {/* 見本は結果一覧と同じ部品（TldCell / PriceLines）で組んでいる。
                見本だけ別の並び・別の書式で価格を出すと、検索後にその約束が
                破られることになる。 */}
            <ul className={TLD_GRID}>
              {[
                { tld: '.com', glyph: '◯', text: '空きあり', tone: 'text-green-brand', pick: true },
                { tld: '.net', glyph: '✕', text: '使用中', tone: 'text-destructive', pick: false },
                { tld: '.site', glyph: '◯', text: '空きあり', tone: 'text-green-brand', pick: true },
                { tld: '.tech', glyph: '？', text: '確認できませんでした', tone: 'text-muted-foreground', pick: false },
              ].map((row) => (
                <TldCell
                  key={row.tld}
                  tld={row.tld}
                  domain={`my-shop${row.tld}`}
                  pricing={getTldPricingOrDefault(row.tld)}
                  muted={!row.pick}
                  status={
                    row.pick ? (
                      /* asChild = 見本なのでフォーカスも押下もできない span。
                         それでも実物のボタンと同じ見た目になる。 */
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="h-auto w-full flex-col gap-0.5 rounded-md px-1 py-1.5 leading-tight"
                      >
                        <span aria-hidden="true">
                          <span className="text-[17px] leading-5 text-green-brand">{row.glyph}</span>
                          <span className="text-[11px] font-bold">選択する</span>
                        </span>
                      </Button>
                    ) : (
                      <span aria-hidden="true" className={`block ${row.tone}`}>
                        <span className="block text-[17px] leading-5">{row.glyph}</span>
                        <span className="block text-[11px] leading-tight font-bold text-balance">{row.text}</span>
                      </span>
                    )
                  }
                />
              ))}
            </ul>
            <p className="mt-4 text-[12.5px] text-ink-faint">
              ※ 表示は見本です。実際の空き状況は検索したときにレジストリへ問い合わせて表示します。
            </p>
          </div>
        </div>
      </section>

      {/* ── 機能紹介（かんたんモード / AI / つなぐ） ────────────────── */}
      {/* 直前の 結果見本 が bg-paper-2 の帯なので、ここは地のまま（--paper）。
          見本パネルは bg-card + shadow-soft なので、紙の上でも十分に浮く。 */}
      <section className={SECTION_Y}>
        <div className={WRAP}>
          <LandingFeatures />
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────── */}
      <section className={SECTION_Y}>
        <div className={WRAP}>
          {/* 帯そのものは横に広いのに中身は2ブロックしかないので、縦を詰めて
              帯の高さを中身に合わせる（以前は sm:py-13 で上下が空いていた）。 */}
          <div className="relative flex flex-wrap items-center justify-between gap-x-8 gap-y-5 overflow-hidden rounded-none bg-grass-1 px-7 py-7 sm:px-10 sm:py-8">
            <span className="leaf -top-17 -right-22 h-[240px] w-[340px] rotate-[20deg] bg-grass-2 opacity-60" />
            <div className="relative z-1">
              <h2 className="mb-1.5 text-[22px] font-black text-balance sm:text-[26px]">
                思いついた名前、いま空いているかも。
              </h2>
              <p className="text-sm text-muted-foreground">入力するのは名前だけ。ログインもカード登録も要りません。</p>
            </div>
            <Button
              type="button"
              size="lg"
              className="relative z-1 h-13 rounded-none px-8 font-heading text-[15px] font-bold"
              onClick={() => {
                const field = document.getElementById(heroFieldId)
                field?.scrollIntoView({ block: 'center' })
                field?.focus()
              }}
            >
              ドメインを検索する
            </Button>
          </div>
        </div>
      </section>
        </>
      )}
    </div>
  )
}
