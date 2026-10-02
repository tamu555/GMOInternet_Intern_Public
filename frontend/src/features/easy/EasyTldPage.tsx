/**
 * ステップ3: ドメインの末尾（TLD）を選ぶ（/easy/tld）＝検索結果の画面。
 *
 * ## 一覧の形（2026-08-27 に変更）
 *
 * 通常モードの結果一覧（DomainSelectTable の TldCell / TLD_GRID）と同じ、
 * 「1つの末尾＝1つのセル」を横に並べた帯にした。それまでは縦に長い行を3件だけ
 * 出し、残り19件を「ほかの候補を見る」の中に畳んでいた。
 *
 * 畳むのをやめた理由は、通常モードがページャを捨てたのと同じ:
 * 畳まれている間、初心者には「これで全部なのか」「もっと安いものが隠れていない
 * か」が判断できない。判断できないまま「次へ」を押させるのは、選ばせているよう
 * で選ばせていない。全部を1画面に出せば、比較そのものが要らなくなる。
 *
 * 仕様 §6.2.4 の「おすすめTLDを3件提示」は、畳むこと自体を求めてはいない
 * （求めているのは3件を提示することと、各候補に推薦理由を1行添えること）。
 * そこで、おすすめ3件は上の帯に大きめのカードとして残し、残りは畳まずに下の
 * 一覧へ出す。「その他」を開く操作は無くなる。
 *
 * 料金は初年度と更新料を同じ文字サイズで並記する（§6.2.5）。畳んではいけない。
 * セル内でも1つの定数（PRICE_AMOUNT）を両方に当てて、片方だけ小さくする改変が
 * 構造的にできないようにしてある。
 *
 * TLD固有の注意（プレミアム価格など）も候補提示の時点で出す（§6.2.4）。
 * おすすめカードでは本文をそのまま、一覧のセルでは ※ 印を付けて一覧直下に
 * 注記を並べる（通常モードと同じ作法）。
 *
 * 「TLD」という語をいきなり出さず「ドメインの末尾（.com など）」と説明し、用語は
 * 小さな補足として添える（仕様 §1.4: 用語は削除せず注釈する）。
 *
 * 空き状況は 4 値のまま扱う。確認できなかった TLD を「取得できます」に混ぜない
 * のはもちろん、「取得済み」に落とすこともしない（仕様 §6.7）。レジストリが
 * 到達不能と判定された TLD は「一時的に取得できません」で、これも「取得済み」
 * とは別物（docs/仕様/registry-unavailable.md §5.2）。
 *
 * 選択肢はすべて role="radio"（選べないものも disabled な radio として置く）。
 * 通常モードのカート用トグルボタンとは違い、ここは1つだけ選ぶ画面なので、
 * 「複数選べるのでは」と読める形にはしない。読み上げ名には必ず
 * 「ドメイン名 + 空き状況」を入れる。
 *
 * 次の 4/6（内容の確認）は <RequireAuth> 配下なので、未ログインの人はこの画面で
 * ログインを済ませてもらう。案内文だけ出して /login へ飛ばすとウィザードから
 * 落ちたように見えるため、ここに本物のログインフォーム（<LoginForm>）を出す。
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { useAuth } from '../../auth/useAuth'
import { StatusBanner } from '../../components/StatusBanner'
import { LoginForm } from '../auth/LoginForm'
import { searchDomains, type DomainSearchResultItem } from '../../api/domainsSearchApi'
import { TLDS_FALLBACK_NOTICE, messageForSearchError } from '../domains/domainMessages'
import {
  TLD_CELL_FOOT,
  TLD_CELL_HEAD,
  TLD_CELL_HEAD_ACTIVE,
  TLD_CELL_HEAD_MUTED,
  TLD_CELL_PRICE,
  TLD_CELL_SHELL,
  TLD_CELL_SHELL_IDLE,
  TLD_CELL_SHELL_SELECTED,
  TLD_GRID,
} from '../domains/DomainSelectTable'
import { formatYen, getTldMeta, getTldPricingOrDefault, type TldPricing } from '../domains/tldData'
import { useSupportedTlds } from '../domains/useSupportedTlds'
import { EasyPageHeader, EasyStepActions, EasyStepNav } from './EasyStepActions'
import {
  ACTION_BACK_TO_CONFIRM,
  LOGIN_CARD_HEADING,
  LOGIN_CARD_SIGNUP_ACTION,
  LOGIN_CARD_SIGNUP_PROMPT,
  LOGIN_REQUIRED_NOTICE,
  NAME_AVAILABLE_LABEL,
  NAME_MAINTENANCE_LABEL,
  NAME_TAKEN_LABEL,
  NAME_UNAVAILABLE_LABEL,
  NAME_UNKNOWN_LABEL,
  TLD_BEST_BADGE,
  TLD_CHOSEN_NAME_LABEL,
  TLD_EMPTY_MESSAGE,
  TLD_FIRST_YEAR_LABEL,
  TLD_HEADING,
  TLD_JARGON_NOTE,
  TLD_LEDE,
  TLD_LEGEND_NOTE,
  TLD_OTHERS_SECTION,
  TLD_PRICE_NOTE,
  TLD_RECOMMENDED_SECTION,
  TLD_RENEWAL_LABEL,
  TLD_REQUIRED_ERROR,
  TLD_SELECT_ACTION,
  TLD_SELECTED_LABEL,
  TLD_SORT_LABEL,
  TLD_UNAVAILABLE_SECTION,
} from './easyMessages'
import {
  EASY_TLD_FILTERS,
  fitForTld,
  rankByPurpose,
  rankTlds,
  reasonForPurposeTld,
} from './purposeTldPriority'
import { easyStepDef, type EasyPurposeKind, type EasyTldFilter } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'
import { easyNameResultsPath, useEasyReturn } from './useEasyReturn'

/* 料金2行の共有クラス。初年度と更新料を同じ文字サイズで出す規定（§6.2.5）を
   「同じ定数を両方に当てる」ことで構造的に守る — 片方だけ小さくする改変が
   できないようにするための1本化。 */
const PRICE_LABEL = 'text-[11px] leading-5 text-ink-faint'
const PRICE_AMOUNT = 'font-en text-[17px] leading-6 font-semibold tabular-nums'

/* セル内の同じ2行。ラベルを金額の上に置いて中央寄せにするのは、
   「2年目以降 毎年」が通常モードの「更新」より長く、横並びだと
   104px のセルで折り返してしまうため。金額側のクラスは1本のまま。 */
const CELL_PRICE_LABEL = 'block text-[10px] leading-4 text-ink-faint'
const CELL_PRICE_AMOUNT = 'block font-en text-[13px] leading-[1.35] font-semibold tabular-nums'

/** おすすめとして上の帯に出す件数（仕様 §6.2.4「おすすめTLDを3件提示」）。 */
const RECOMMENDED_COUNT = 3


type StateView = {
  glyph: string
  /** バッジと読み上げ名に使う言葉。記号だけで意味を伝えない。 */
  text: string
  badge: 'default' | 'destructive' | 'outline' | 'secondary'
  tone: string
}

/**
 * 空き状況の 4 値（§6.7 + registry-unavailable.md §5.2）。
 * ここで潰すと「取れるのに取れないと言う」「取れないのに取れると言う」の
 * どちらかが必ず起きるので、1つも他の値に寄せない。
 */
function describeState(result: DomainSearchResultItem): StateView {
  if (result.state === 'available') {
    return { glyph: '◯', text: NAME_AVAILABLE_LABEL, badge: 'default', tone: 'text-green-brand' }
  }
  if (result.state === 'taken') {
    return { glyph: '✕', text: NAME_TAKEN_LABEL, badge: 'destructive', tone: 'text-destructive' }
  }
  if (result.state === 'unavailable') {
    // レジストリ到達不能の判定後。メンテナンスとは断定せず、「取得済み」にも落とさない。
    return { glyph: '⏳', text: NAME_UNAVAILABLE_LABEL, badge: 'outline', tone: 'text-muted-foreground' }
  }
  if (result.state === 'maintenance') {
    // レジストリ自身が告知した窓の最中。ここだけはメンテナンスと言い切れる。
    return { glyph: '🔧', text: NAME_MAINTENANCE_LABEL, badge: 'outline', tone: 'text-muted-foreground' }
  }
  if (result.unknownReason === 'unsupported') {
    return { glyph: '−', text: '取り扱いがありません', badge: 'outline', tone: 'text-muted-foreground' }
  }
  return { glyph: '？', text: NAME_UNKNOWN_LABEL, badge: 'outline', tone: 'text-muted-foreground' }
}

/** 初年度と更新料の2行。どちらも同じ金額クラス（§6.2.5）。 */
function EasyPriceLines({ pricing }: { pricing: TldPricing | undefined }) {
  if (!pricing) return <span className={PRICE_AMOUNT}>—</span>
  return (
    <>
      <span className="flex items-baseline gap-2 sm:justify-end">
        <span className={PRICE_LABEL}>{TLD_FIRST_YEAR_LABEL}</span>
        <span className={PRICE_AMOUNT}>{formatYen(pricing.firstYearYen)}</span>
      </span>
      <span className="flex items-baseline gap-2 sm:justify-end">
        <span className={PRICE_LABEL}>{TLD_RENEWAL_LABEL}</span>
        <span className={PRICE_AMOUNT}>{formatYen(pricing.renewalYearYen)}</span>
      </span>
    </>
  )
}

/** 同じ2行のセル版。ラベルを上、金額を下に積む。金額クラスは1本。 */
function CellPriceLines({ pricing }: { pricing: TldPricing | undefined }) {
  if (!pricing) return <span className={CELL_PRICE_AMOUNT}>—</span>
  return (
    <>
      <span className="block">
        <span className={CELL_PRICE_LABEL}>{TLD_FIRST_YEAR_LABEL}</span>
        <span className={CELL_PRICE_AMOUNT}>{formatYen(pricing.firstYearYen)}</span>
      </span>
      <span className="mt-1 block">
        <span className={CELL_PRICE_LABEL}>{TLD_RENEWAL_LABEL}</span>
        <span className={CELL_PRICE_AMOUNT}>{formatYen(pricing.renewalYearYen)}</span>
      </span>
    </>
  )
}

/**
 * 一覧の 1 セル。通常モードの TldCell と同じ枠（クラスを共有している）に、
 * カート用トグルではなく radio を入れたもの。
 *
 * セルが出すのは末尾だけで、名前の部分は一覧の上に1回だけ出す（通常モードと
 * 同じ作法）。読み上げ名にはドメイン名も空き状況も入れる — radio の
 * aria-label に両方書いてあるので、見出しやセルの見た目を変えても崩れない。
 */
function EasyTldCell({
  result,
  controlId,
  selected,
}: {
  result: DomainSearchResultItem
  controlId: string
  selected: boolean
}) {
  const pricing = getTldPricingOrDefault(result.tld)
  const caveat = getTldMeta(result.tld)?.caveat
  const state = describeState(result)
  const selectable = result.state === 'available'

  /* セル全体が 1 つの <label>。末尾の名前を押しても料金を押しても選べる
     ようにするため — 下端の丸だけが当たり判定だと、狙って押す操作になる。 */
  return (
    <Label
      htmlFor={controlId}
      /* items-stretch / gap-0 は shadcn <Label> の既定（flex items-center gap-2）
         の打ち消し。3本の帯を隙間なく積むのがセルの形。 */
      className={cn(
        TLD_CELL_SHELL,
        'items-stretch gap-0 leading-normal font-normal',
        selected ? TLD_CELL_SHELL_SELECTED : TLD_CELL_SHELL_IDLE,
        selectable ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <span className={cn(TLD_CELL_HEAD, selectable ? TLD_CELL_HEAD_ACTIVE : TLD_CELL_HEAD_MUTED)}>
        {result.tld}
        {caveat ? (
          <span aria-hidden="true" className="text-ink-faint">
            ※
          </span>
        ) : null}
      </span>

      <span className={cn('block', TLD_CELL_PRICE, !selectable && 'text-ink-faint')}>
        <CellPriceLines pricing={pricing} />
      </span>

      <span className={cn(TLD_CELL_FOOT, 'flex-col gap-1')}>
        <RadioGroupItem
          id={controlId}
          value={result.tld}
          disabled={!selectable}
          /* 見た目は末尾だけでも、読み上げは「ドメイン名 + 空き状況」。
             §6.7 の状態がそのまま読み上げ名に出る。 */
          aria-label={`${result.domain} ${state.text}`}
        />
        <span aria-hidden="true" className={cn('text-[11px] leading-tight font-bold', state.tone)}>
          {selectable ? (selected ? TLD_SELECTED_LABEL : TLD_SELECT_ACTION) : state.text}
        </span>
      </span>
    </Label>
  )
}

/**
 * おすすめ 3 件のカード。仕様 §6.2.4 が求める「推薦理由を1行」と、
 * TLD 固有の注意（プレミアム価格など）を、畳まずにここへ出す。
 *
 * ⚠️ 「詳しく見る」の折りたたみと「おすすめ度（★3段）」は 2026-08-28 に廃止した。
 * 開いて増えるのは星と、いちばんおすすめ以外に出す推薦理由の 1 行だけで、その
 * 理由は目的ごとの文＝3枚とも同じ文だった。つまり「開く手間の先に、選ぶ材料が
 * 増えない」畳み方になっていた。3 枚を区別できるのは TLD ごとの fitForTld()
 * なので、それを本文に出したまま、畳みごと消している。
 */
function RecommendedTldCard({
  result,
  purpose,
  controlId,
  selected,
  best,
}: {
  result: DomainSearchResultItem
  purpose: EasyPurposeKind
  controlId: string
  selected: boolean
  best: boolean
}) {
  const pricing = getTldPricingOrDefault(result.tld)
  const caveat = getTldMeta(result.tld)?.caveat
  const state = describeState(result)

  return (
    <div
      className={cn(
        'flex h-full flex-col gap-2 p-4 shadow-soft transition-colors',
        selected ? 'bg-grass-1' : 'bg-card',
      )}
    >
      <Label htmlFor={controlId} className="flex cursor-pointer items-start gap-3">
        <RadioGroupItem
          id={controlId}
          value={result.tld}
          className="mt-1"
          aria-label={`${result.domain} ${state.text}`}
        />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          {/* この行の主役はドメイン名。ここが小さいと、何を選んでいるのかが
              読み取れない（バッジや料金のほうが目に入ってしまう）。 */}
          <span className="font-mono text-[19px] leading-tight font-bold break-all text-green-darkest">
            {result.domain}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant={state.badge} className="gap-1">
              <span aria-hidden="true">{state.glyph}</span>
              {state.text}
            </Badge>
            {best ? <Badge variant="secondary">{TLD_BEST_BADGE}</Badge> : null}
          </span>
        </span>
      </Label>

      {/* §6.2.5: 初年度と更新料は同じ文字サイズ（PRICE_AMOUNT を両方に当てる）。 */}
      <div className="space-y-0.5 sm:text-right">
        <EasyPriceLines pricing={pricing} />
      </div>

      {/* §6.2.4「各候補に推薦理由を1行」。
          reasonForPurposeTld() は目的ごとの文なので、おすすめ3件に当てると
          3枚とも同じ1行になり、選ぶ材料にならない。3枚を区別できるのは
          TLDごとの fitForTld() のほうなので、各カードはこちらを出す。
          目的に対する「なぜ1位なのか」は、いちばんおすすめの1枚だけに添える。

          ⚠️ mt-auto でこの説明群をカードの下端に寄せる。3枚は grid の stretch で
          同じ高さになるが、行数は 1〜3 行とまちまち（いちばんおすすめだけ理由が
          1 行増え、caveat を持つ末尾はさらに 1 行増える）。上詰めのままだと
          行数の少ないカードの下に 49px の空白が残り、書きかけに見える
          （実測 2026-08-28: 最後の行から下端まで 1枚目 16px / 2・3枚目 65px）。
          以前はここに「詳しく見る」の折りたたみが mt-auto で入っていて、その
          空白を埋めていた。畳みを消すなら、この仕事は残りが引き取る必要がある。 */}
      <div className="mt-auto space-y-1">
        <p className="text-[12.5px] leading-relaxed text-foreground">{fitForTld(result.tld)}</p>
        {best ? (
          <p className="text-[12.5px] leading-relaxed text-green-deep">
            {reasonForPurposeTld(purpose, result.tld)}
          </p>
        ) : null}

        {/* §6.2.4: TLD固有の罠は候補提示の時点で見せる（畳まない）。 */}
        {caveat ? <p className="text-[12.5px] leading-relaxed text-destructive">{caveat}</p> : null}
      </div>
    </div>
  )
}

function SectionHeading({ text, tone }: { text: string; tone: string }) {
  return <h2 className={cn('text-[13px] font-bold', tone)}>{text}</h2>
}

export function EasyTldPage() {
  const gate = useEasyGate('tld')
  const idPrefix = useId()
  const navigate = useNavigate()
  /* 確認画面の「変更」から来たか。この画面の「次へ」は元から確認画面へ進むので、
     行き先は変えず、戻る先とボタンの文言だけを文脈に合わせる。 */
  const returnTo = useEasyReturn()
  const { session, chooseTld, setStepError, stepErrors } = useEasy()
  const { state: authState } = useAuth()
  const { tlds, loading: tldsLoading, usingFallback } = useSupportedTlds()

  const [results, setResults] = useState<DomainSearchResultItem[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [filter, setFilter] = useState<EasyTldFilter>('price')
  const [chosen, setChosen] = useState(session.tld)

  const label = session.label
  const purpose = session.purpose

  useEffect(() => {
    if (tldsLoading || tlds.length === 0 || !label) return
    const controller = new AbortController()

    async function run() {
      try {
        const response = await searchDomains({ label, tlds }, controller.signal)
        setResults(response.results)
        setSearchError(null)
      } catch (error) {
        if (controller.signal.aborted) return
        setResults(null)
        setSearchError(messageForSearchError(error))
      }
    }

    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount: every setState happens after an await.
    void run()
    return () => controller.abort()
  }, [label, tlds, tldsLoading])

  /**
   * 画面は 2 つの並びを別々に持つ。
   *
   *   おすすめ帯（上の 3 枚）… つねに目的順（rankByPurpose）。利用者が選ぶ
   *     並び替えの軸には従わない。従わせると、上の 3 枚が「目的に合うおすすめ」を
   *     名乗ったまま中身だけ別物になる。
   *   ほかの末尾（下の一覧）… 利用者が選んだ軸（rankTlds）。
   *
   * ⚠️ おすすめ帯に出した 3 件は下の一覧から外す（同じセルを 2 か所に出さない）。
   */
  const sections = useMemo(() => {
    if (!results || !purpose) {
      return { recommended: [], others: [], unavailable: [] as DomainSearchResultItem[] }
    }
    const available = results.filter((result) => result.state === 'available')
    const byTld = new Map(available.map((result) => [result.tld, result]))
    const pick = (tld: string) => byTld.get(tld)
    const isItem = (entry: DomainSearchResultItem | undefined): entry is DomainSearchResultItem =>
      entry !== undefined

    const byPurpose = rankByPurpose(available.map((result) => result.tld), purpose)
    const recommendedTlds = byPurpose.slice(0, RECOMMENDED_COUNT)
    const otherTlds = rankTlds(byPurpose.slice(RECOMMENDED_COUNT), filter)

    return {
      recommended: recommendedTlds.map(pick).filter(isItem),
      others: otherTlds.map(pick).filter(isItem),
      unavailable: results.filter((result) => result.state !== 'available'),
    }
  }, [results, purpose, filter])

  if (gate) return gate
  if (!purpose) return null

  /* おすすめ3件（§6.2.4）は上の帯へ。残りは畳まずに下の一覧へ出す。 */
  const { recommended, others, unavailable } = sections

  /* 取得できる末尾のうち、いちばん上＝おすすめを初期選択にする。ユーザーが
     何も触らずに「次へ」を押しても、おすすめのまま進める（推奨値の自動設定）。 */
  const selectable = [...recommended, ...others].map((result) => result.tld)
  const selectedTld = selectable.includes(chosen) ? chosen : (selectable[0] ?? '')
  const loading = results === null && searchError === null

  /* 一覧に ※ を付けた末尾の注記。おすすめカードは本文をそのまま出しているので、
     ここに並べるのは一覧側（others / unavailable）に出ている分だけ。 */
  const caveats = [...others, ...unavailable]
    .map((result) => ({ tld: result.tld, caveat: getTldMeta(result.tld)?.caveat }))
    .filter((entry): entry is { tld: string; caveat: string } => Boolean(entry.caveat))

  function handleNext() {
    if (!selectedTld) {
      setStepError('tld', TLD_REQUIRED_ERROR)
      return
    }
    setStepError('tld', null)
    chooseTld(selectedTld)
    navigate(easyStepDef('confirm').path)
  }

  /* この画面に埋め込んだログインが成立したときだけ呼ばれる（/login と違って
     <RequireGuest> が無いので、続きへ送るのはこちらの仕事）。

     末尾が1つも選べていないときは進まない。ログインカードだけが消えて、この
     画面に留まる — 選んでいないものを持って確認画面へ行っても意味がないため。

     下書きは chooseTld() が localStorage へ書く。この時点で保存スコープがまだ
     'guest' でも、認証の反映後に EasyProvider が uid スコープへ引き継ぐので
     選んだ末尾は失われない（EasyProvider.tsx の loadForScope を参照）。 */
  function handleLoginSuccess() {
    if (!selectedTld) return
    setStepError('tld', null)
    chooseTld(selectedTld)
    navigate(easyStepDef('confirm').path)
  }

  return (
    <div className="space-y-6">
      {/* 「戻る」で返す先は検索フォームではなく検索結果。見ていた候補の一覧を
          そのまま返さないと、名前を選び直したい人がもう一度検索させられる。 */}
      <EasyStepNav backTo={returnTo ? easyStepDef(returnTo).path : easyNameResultsPath(null, null)} />

      <EasyPageHeader title={TLD_HEADING} lede={TLD_LEDE} />

      {usingFallback ? <StatusBanner tone="info">{TLDS_FALLBACK_NOTICE}</StatusBanner> : null}
      {searchError ? <StatusBanner tone="error">{searchError}</StatusBanner> : null}
      {stepErrors.tld ? <StatusBanner tone="error">{stepErrors.tld}</StatusBanner> : null}

      {loading ? (
        <div className="space-y-3" role="status">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            空き状況を確認しています…
          </p>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-40 w-full" />
            ))}
          </div>
          <div className={TLD_GRID}>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((index) => (
              <Skeleton key={index} className="h-28 w-full" />
            ))}
          </div>
        </div>
      ) : selectable.length === 0 ? (
        <StatusBanner tone="info">{TLD_EMPTY_MESSAGE}</StatusBanner>
      ) : (
        <>
          {/* セルは末尾だけを出すので、名前の部分はここで1回だけ見せる
              （通常モードが検索語を一覧の上に1回だけ出すのと同じ）。 */}
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-muted-foreground">{TLD_CHOSEN_NAME_LABEL}</span>
            <span className="font-mono text-[20px] leading-tight font-bold break-all text-green-darkest">
              {label}
              {/* 一覧のセルは末尾しか出さないので、下の帯から選んだ人は「結局どの
                  ドメインになったのか」をここでしか確認できない。選ぶたびに
                  ここが変わるのが、選べたことの唯一の手応えになる。 */}
              <span className="text-primary">{selectedTld}</span>
            </span>
          </p>

          <RadioGroup
            aria-label={TLD_HEADING}
            value={selectedTld}
            onValueChange={(value) => {
              setChosen(value)
              setStepError('tld', null)
            }}
            className="gap-6"
          >
            <section className="space-y-2.5">
              <SectionHeading
                text={`${TLD_RECOMMENDED_SECTION}（${recommended.length}件）`}
                tone="text-green-brand"
              />
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {recommended.map((result, index) => (
                  <RecommendedTldCard
                    key={result.tld}
                    result={result}
                    purpose={purpose}
                    controlId={`${idPrefix}-${result.tld}`}
                    selected={selectedTld === result.tld}
                    best={index === 0}
                  />
                ))}
              </div>
            </section>

            {others.length > 0 ? (
              <section className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                  <SectionHeading
                    text={`${TLD_OTHERS_SECTION}（${others.length}件）`}
                    tone="text-green-brand"
                  />
                  {/* 比較の軸は通常モードの「並び替え」と同じ位置・同じ形にする。
                      畳んでおくと、並び替えられること自体に気づかれない。 */}
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={TLD_SORT_LABEL}>
                    <span className="text-[13px] text-muted-foreground">{TLD_SORT_LABEL}</span>
                    {EASY_TLD_FILTERS.map((entry) => (
                      <Button
                        key={entry.id}
                        type="button"
                        variant={filter === entry.id ? 'secondary' : 'ghost'}
                        size="sm"
                        className="h-8 px-3 text-[13px]"
                        aria-pressed={filter === entry.id}
                        onClick={() => setFilter(entry.id)}
                      >
                        {entry.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  {EASY_TLD_FILTERS.find((entry) => entry.id === filter)?.hint}
                </p>
                <div className={TLD_GRID}>
                  {others.map((result) => (
                    <EasyTldCell
                      key={result.tld}
                      result={result}
                      controlId={`${idPrefix}-${result.tld}`}
                      selected={selectedTld === result.tld}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {unavailable.length > 0 ? (
              <section className="space-y-2.5">
                <SectionHeading
                  text={`${TLD_UNAVAILABLE_SECTION}（${unavailable.length}件）`}
                  tone="text-ink-faint"
                />
                <div className={TLD_GRID}>
                  {unavailable.map((result) => (
                    <EasyTldCell
                      key={result.tld}
                      result={result}
                      controlId={`${idPrefix}-${result.tld}`}
                      selected={false}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </RadioGroup>

          {/* 注記はまとめて一覧の下に置く。§1.4 の用語（TLD）もここで 1 度だけ
              渡す — 見出しの下に置くと、選ぶ前に読む文が 1 本増えるだけになる。 */}
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>{TLD_LEGEND_NOTE}</p>
            <p>{TLD_PRICE_NOTE}</p>
            <p>{TLD_JARGON_NOTE}</p>
            {caveats.map((entry) => (
              <p key={entry.tld}>
                ※ <strong className="font-mono font-semibold">{entry.tld}</strong> — {entry.caveat}
              </p>
            ))}
          </div>
        </>
      )}

      {/* 未ログインならここでログインまで済ませる。別画面へ飛ばすと、ウィザードの
          途中で放り出されたように見えるうえ、6ステップ中どこにいるかを見失う。
          ログインが成立したら handleLoginSuccess がそのまま 4/6 へ送る。 */}
      {authState.status === 'unauthenticated' ? (
        <Card className="w-full max-w-md" size="sm">
          <CardHeader>
            <h2 className="font-heading text-base leading-snug font-bold text-green-brand">
              {LOGIN_CARD_HEADING}
            </h2>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">{LOGIN_REQUIRED_NOTICE}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <LoginForm onSuccess={handleLoginSuccess} />
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {LOGIN_CARD_SIGNUP_PROMPT}{' '}
              <Link to="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
                {LOGIN_CARD_SIGNUP_ACTION}
              </Link>
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* この画面の「次へ」の行き先は元から確認画面なので、文言だけ言い換える。 */}
      <EasyStepActions
        onNext={handleNext}
        nextLabel={returnTo ? ACTION_BACK_TO_CONFIRM : undefined}
        nextDisabled={!selectedTld}
      />
    </div>
  )
}
