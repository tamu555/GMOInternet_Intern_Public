/**
 * ステップ2後半: 検索結果（/easy/name/results）。
 *
 * 検索フォーム（/easy/name）から切り出した「候補を見て 1 つ選ぶ」だけの画面。
 * 分けた理由は EasyNamePage.tsx の冒頭に書いたとおりで、この画面が引き受ける
 * のは選ぶことだけ。切り替わりの演出は EasyLayout の Outlet（パスを key にした
 * fade + slide）がまとめて持つので、ここには置かない。
 *
 * 実行した検索はクエリ `?q=` が正（通常モードの DomainSearchPage と同じ）。
 * URL が変わるたびに候補を作り直すので、リロードでも共有リンクでも同じ結果に
 * 戻る。`q` が無いときだけは保存済みの候補をそのまま見せる — 末尾の画面から
 * 「戻る」で帰ってきた人に、見ていた一覧をそのまま返すため。
 *
 * 候補の「生成」はモック（easyNameApi.ts）だが、「空きあり」の表示は必ず実APIの
 * 応答に基づく。生成器の言い分だけで空きを主張しないのは、既存 suggestionEngine
 * と同じ原則（仕様 §6.7）。確認できなかったものは ✕ ではなく ？ にする。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Heart, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { StatusBanner } from '../../components/StatusBanner'
import type { DomainAvailabilityState } from '../../api/domainsSearchApi'
import { TLDS_FALLBACK_NOTICE } from '../domains/domainMessages'
import { useSupportedTlds } from '../domains/useSupportedTlds'
import { EasyPageHeader, EasyStepActions, EasyStepNav } from './EasyStepActions'
import { EasySearchForm } from './EasySearchForm'
import { checkCandidates, fetchNameSuggestions, type LabelAvailability } from './easyNameApi'
import {
  ACTION_BACK_TO_CONFIRM,
  NAME_ALL_TAKEN_ERROR,
  NAME_AVAILABLE_LABEL,
  NAME_BEST_BADGE,
  NAME_CHECKING_LABEL,
  NAME_FAVORITE_ADD,
  NAME_FAVORITE_REMOVE,
  NAME_LESS_ACTION,
  NAME_MAINTENANCE_LABEL,
  NAME_MORE_ACTION,
  NAME_OWN_BADGE,
  NAME_REQUIRED_ERROR,
  NAME_RESEARCH_ACTION,
  NAME_RESULTS_HEADING,
  NAME_RESULTS_LEDE,
  NAME_SUGGESTIONS_EMPTY,
  NAME_SUGGESTIONS_HEADING,
  NAME_SUGGESTIONS_LOADING,
  NAME_TAKEN_LABEL,
  NAME_UNAVAILABLE_LABEL,
  NAME_UNKNOWN_LABEL,
} from './easyMessages'
import { easyStepDef, type EasyNameCandidate } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'
import { easyNameResultsPath, easyStepPathWithReturn, useEasyReturn } from './useEasyReturn'

/** 最初に見せる候補の件数（残りは「ほかの候補を見る」の中）。 */
const INITIAL_VISIBLE = 3

const AVAILABILITY_BADGE: Record<
  DomainAvailabilityState,
  { label: string; glyph: string; variant: 'default' | 'destructive' | 'outline' }
> = {
  available: { label: NAME_AVAILABLE_LABEL, glyph: '◯', variant: 'default' },
  taken: { label: NAME_TAKEN_LABEL, glyph: '✕', variant: 'destructive' },
  unknown: { label: NAME_UNKNOWN_LABEL, glyph: '？', variant: 'outline' },
  // 購入不可が確定している唯一の「不明」状態（§6.9）。？に丸めない。
  unavailable: { label: NAME_UNAVAILABLE_LABEL, glyph: '⏳', variant: 'outline' },
  // レジストリ自身が告知したメンテナンス窓の最中（registry-unavailable.md）。
  maintenance: { label: NAME_MAINTENANCE_LABEL, glyph: '🔧', variant: 'outline' },
}

/**
 * 「まだ確認していない」は 4 つめの表示状態。unknown（＝確認して分からなかった）に
 * 丸めると、検索直後の一瞬、全候補が「？ 確認できませんでした」と嘘をつく。
 */
function CheckingBadge() {
  return (
    <Badge variant="outline" className="shrink-0 gap-1">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      {NAME_CHECKING_LABEL}
    </Badge>
  )
}

function AvailabilityBadge({ state }: { state: DomainAvailabilityState }) {
  const badge = AVAILABILITY_BADGE[state]
  return (
    <Badge variant={badge.variant} className="shrink-0 gap-1">
      {/* 色だけで意味を持たせない: 記号と文字を必ず併記する（§6.7）。 */}
      <span aria-hidden="true">{badge.glyph}</span>
      {badge.label}
    </Badge>
  )
}

export function EasyNameResultsPage() {
  const gate = useEasyGate('name')
  const idPrefix = useId()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  /* 確認画面の「変更」から来たか（来ていなければ通常の一本道）。 */
  const returnTo = useEasyReturn()
  const { session, saveCandidates, toggleFavorite, choosePurpose, chooseLabel, setStepError, stepErrors } =
    useEasy()
  const { tlds, loading: tldsLoading, usingFallback } = useSupportedTlds()

  /* 実行した検索。null は「検索していない＝保存済みの候補を見に来た」。 */
  const seed = searchParams.get('q')
  const [availability, setAvailability] = useState<Record<string, DomainAvailabilityState>>({})
  const [checking, setChecking] = useState(false)
  const [chosen, setChosen] = useState(session.label)
  const [expanded, setExpanded] = useState(
    () => session.candidates.findIndex((candidate) => candidate.label === session.label) >= INITIAL_VISIBLE,
  )
  /* エラーバナーは画面の上、「次へ」は最下部。モバイルで押しても何も起きて
     いないように見えるので、出したエラーまで視界を運ぶ。 */
  const errorRef = useRef<HTMLDivElement>(null)

  const purpose = session.purpose
  const purposeNote = session.purposeNote

  /* 「どの検索の結果か」を 1 本の文字列にまとめて state に持たせる。生成が
     終わったかどうかは、その鍵が今の URL と一致するかで**描画時に導出する**
     （読み込み中フラグを別に持つと、効果の中で同期的に setState することになる）。
     条件（自由入力）も検索の一部なので鍵に含める — 名前を変えずに条件だけ
     変えた再検索も、ここが変わることでやり直しとして扱われる。 */
  const searchKey = seed === null ? null : `${seed}\n${purposeNote}`
  const [result, setResult] = useState<{ key: string; candidates: EasyNameCandidate[] } | null>(null)
  const resolved = result !== null && result.key === searchKey ? result : null
  const generating = searchKey !== null && resolved === null
  /* 検索していないとき（?q= 無し）は、末尾の画面から戻ってきた人に保存済みの
     一覧をそのまま返す。 */
  const candidates = useMemo(
    () => (searchKey === null ? session.candidates : (resolved?.candidates ?? [])),
    [searchKey, session.candidates, resolved],
  )

  /* URL の検索（?q=）を実行する。候補の生成はここだけで走り、結果は下書きにも
     保存する（末尾の画面から戻ってきた人に同じ一覧を返すため）。 */
  useEffect(() => {
    if (searchKey === null || purpose === null) return
    if (result !== null && result.key === searchKey) return
    const key = searchKey
    const seedLabel = seed ?? ''
    const activePurpose = purpose
    let cancelled = false
    async function run() {
      const generated = await fetchNameSuggestions({ purpose: activePurpose, purposeNote, seedLabel })
      if (cancelled) return
      setResult({ key, candidates: generated })
      saveCandidates(generated)
      setChosen(generated[0]?.label ?? '')
      setExpanded(false)
    }
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-change: every setState happens after an await.
    void run()
    return () => {
      cancelled = true
    }
  }, [searchKey, seed, purpose, purposeNote, result, saveCandidates])

  /* 出ている候補のうち、まだ空きを確認していないものだけを実APIで確認する。
     候補は localStorage から復帰することがあり（空き状況は保存しない）、その場合も
     ここで確認が走る。全部確認済みなら早期 return するのでループしない。 */
  useEffect(() => {
    if (tldsLoading || tlds.length === 0) return
    const missing = candidates
      .map((candidate) => candidate.label)
      .filter((label) => !(label in availability))
    if (missing.length === 0) return

    const controller = new AbortController()
    async function run() {
      setChecking(true)
      const results = await checkCandidates(missing, tlds, controller.signal)
      if (controller.signal.aborted) return
      setAvailability((current) => ({ ...current, ...availabilityMap(results) }))
      setChecking(false)
    }
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-change: every setState happens after an await.
    void run()
    return () => controller.abort()
  }, [candidates, availability, tlds, tldsLoading])

  if (gate) return gate
  if (!purpose) return null
  /* 検索もしていないし、見せる候補も無い。結果の画面に留める理由がないので
     検索の画面へ戻す（履歴は積まない ＝ 「戻る」で往復させない）。 */
  if (seed === null && session.candidates.length === 0) {
    return <Navigate to={easyStepPathWithReturn('name', returnTo)} replace />
  }

  /* 選べる候補（取得済みは選べない）。ユーザーがまだ選んでいなければ先頭＝
     おすすめを初期選択にする（＝そのまま「次へ」で進める）。 */
  const selectable = candidates
    .filter((candidate) => availability[candidate.label] !== 'taken')
    .map((candidate) => candidate.label)
  const selectedLabel = selectable.includes(chosen) ? chosen : (selectable[0] ?? '')
  const visible = expanded ? candidates : candidates.slice(0, INITIAL_VISIBLE)

  /* 再検索。フォームと同じ経路を通す（クエリを書き換えるだけ）。 */
  function handleSearch(label: string, note: string) {
    if (!purpose) return
    choosePurpose(purpose, note)
    navigate(easyNameResultsPath(label, returnTo))
  }

  function handleNext() {
    if (!selectedLabel) {
      setStepError('name', NAME_REQUIRED_ERROR)
      // バナーは次の描画で初めて存在するので 1 フレーム待つ。jsdom には
      // scrollIntoView が無いのでオプショナル呼び出しにしてある。
      requestAnimationFrame(() => {
        errorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      })
      return
    }
    setStepError('name', null)
    const labelChanged = selectedLabel !== session.label
    chooseLabel(selectedLabel)
    if (returnTo && !labelChanged) {
      // 名前を変えずに戻っただけ。寄り道させず、そのまま元の画面へ返す。
      navigate(easyStepDef(returnTo).path)
      return
    }
    if (returnTo) {
      /* 名前が変わったので、末尾の空き状況を取り直す必要がある。選んだ末尾が
         新しい名前でも空いている保証がないので、確認画面へ直行させない。
         末尾の画面を経由し、そこから確認画面へ戻る。 */
      navigate(easyStepPathWithReturn('tld', returnTo))
      return
    }
    navigate(easyStepDef('tld').path)
  }

  return (
    <div className="space-y-6">
      {/* 「戻る」は検索の画面へ。確認画面から修正しに来た人だけは、そちらへ返す。 */}
      <EasyStepNav backTo={returnTo ? easyStepDef(returnTo).path : easyStepDef('name').path} />

      <EasyPageHeader title={NAME_RESULTS_HEADING} lede={NAME_RESULTS_LEDE} />

      {/* 検索窓は結果の *上* に残す。名前を変えたくなった人が、戻らずにその場で
          やり直せる（通常モードの結果画面が再検索バーを上に置くのと同じ理由）。 */}
      <EasySearchForm
        key={seed ?? session.label}
        defaultLabel={seed ?? session.label}
        defaultNote={session.purposeNote}
        submitLabel={NAME_RESEARCH_ACTION}
        busy={generating}
        onSearch={handleSearch}
      />

      {usingFallback ? <StatusBanner tone="info">{TLDS_FALLBACK_NOTICE}</StatusBanner> : null}
      {stepErrors.name ? (
        <div ref={errorRef}>
          <StatusBanner tone="error">{stepErrors.name}</StatusBanner>
        </div>
      ) : null}

      {generating ? (
        <ul className="grid list-none gap-3 p-0">
          {[0, 1, 2].map((index) => (
            <li key={index}>
              <Skeleton className="h-20 w-full rounded-xl" />
            </li>
          ))}
        </ul>
      ) : candidates.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{NAME_SUGGESTIONS_EMPTY}</p>
      ) : (
        <section className="space-y-3">
          <h2 className="text-lg font-bold tracking-tight">{NAME_SUGGESTIONS_HEADING}</h2>
          {checking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {NAME_SUGGESTIONS_LOADING}
            </p>
          ) : null}

          <RadioGroup
            aria-label={NAME_SUGGESTIONS_HEADING}
            value={selectedLabel}
            onValueChange={(value) => {
              setChosen(value)
              setStepError('name', null)
            }}
            className="gap-3"
          >
            {visible.map((candidate, index) => {
              // まだ結果が返っていない候補は「？ 確認できませんでした」にしない。
              const checked = candidate.label in availability
              const state = availability[candidate.label] ?? 'unknown'
              const controlId = `${idPrefix}-candidate-${index}`
              const isFavorite = session.favorites.includes(candidate.label)
              const selected = selectedLabel === candidate.label
              const badge = index !== 0 ? null : candidate.label === seed ? NAME_OWN_BADGE : NAME_BEST_BADGE
              return (
                <div
                  key={candidate.label}
                  className={cn(
                    'flex items-center gap-3 bg-card px-4 py-3 shadow-soft transition-colors',
                    selected && 'bg-grass-1',
                  )}
                >
                  <RadioGroupItem
                    value={candidate.label}
                    id={controlId}
                    disabled={
                      checked &&
                      (state === 'taken' || state === 'unavailable' || state === 'maintenance')
                    }
                  />
                  <Label htmlFor={controlId} className="min-w-0 flex-1 cursor-pointer">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-[15px] font-medium break-all">{candidate.label}</span>
                      {checked ? <AvailabilityBadge state={state} /> : <CheckingBadge />}
                      {badge ? <Badge variant="secondary">{badge}</Badge> : null}
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-pressed={isFavorite}
                    aria-label={`${candidate.label} を${isFavorite ? NAME_FAVORITE_REMOVE : NAME_FAVORITE_ADD}`}
                    onClick={() => toggleFavorite(candidate.label)}
                  >
                    <Heart className={cn('size-4', isFavorite && 'fill-current text-primary')} />
                  </Button>
                </div>
              )
            })}
          </RadioGroup>

          {candidates.length > INITIAL_VISIBLE ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((open) => !open)}>
              {expanded ? NAME_LESS_ACTION : `${NAME_MORE_ACTION}（あと${candidates.length - INITIAL_VISIBLE}件）`}
            </Button>
          ) : null}
        </section>
      )}

      {/* 候補が全滅すると「次へ」は押せないまま理由を言えない。押せない理由と
          次の一手を、ボタンのすぐ上に出す。 */}
      {!generating && candidates.length > 0 && selectable.length === 0 ? (
        <StatusBanner tone="error">{NAME_ALL_TAKEN_ERROR}</StatusBanner>
      ) : null}

      {/* ⚠️ 名前を変えたときは末尾の画面を経由するので、ここは「次へ」のまま。
          「確認画面に戻る」と名乗れるのは、名前が変わっていないときだけ。 */}
      <EasyStepActions
        onNext={handleNext}
        nextLabel={returnTo && selectedLabel === session.label ? ACTION_BACK_TO_CONFIRM : undefined}
        nextDisabled={!selectedLabel}
        hideNext={generating}
      />
    </div>
  )
}

function availabilityMap(results: LabelAvailability[]): Record<string, DomainAvailabilityState> {
  return Object.fromEntries(results.map((result) => [result.label, result.state]))
}
