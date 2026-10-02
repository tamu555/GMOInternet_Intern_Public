/**
 * ステップ2前半: ドメイン名を探す（/easy/name）＝かんたんモードの検索画面。
 *
 * この画面にあるのは「見出し・入力欄・入力例・検索する」の 4 つだけ。**候補は
 * ここには出さない** — 検索の結果は /easy/name/results が引き受ける
 * （EasyNameResultsPage.tsx）。フォームの下に候補が生えてくる形をやめたのは、
 * 押したあとにどこを見ればいいのかが分からないまま画面が伸びるため。画面が
 * 切り替わること自体が「検索が実行された」という手応えになる。
 *
 * 入力欄は**空のままでも押せる**（目的から候補を作る）ので、それをリード文で
 * 明示する — 名前を思いつけないことは、この画面で初心者が止まる最大の理由である。
 * 見出しの下に置く文はこの 1 本だけで、用語の補足は入力欄の直下（＝その欄の
 * 説明として読める位置）へ送る。検索条件（目的の自由入力）は「くわしい条件を
 * 指定する」の中に畳む（どちらも EasySearchForm.tsx が持つ）。
 */
import { useNavigate } from 'react-router-dom'
import { EasyPageHeader, EasyStepNav } from './EasyStepActions'
import { EasySearchForm } from './EasySearchForm'
import {
  NAME_HEADING,
  NAME_LEDE,
  NAME_SEARCH_ACTION,
} from './easyMessages'
import { easyStepDef } from './easyTypes'
import { useEasy } from './useEasy'
import { useEasyGate } from './useEasyGate'
import { easyNameResultsPath, useEasyReturn } from './useEasyReturn'

export function EasyNamePage() {
  const gate = useEasyGate('name')
  const navigate = useNavigate()
  /* 確認画面の「変更」から来たか（来ていなければ通常の一本道）。 */
  const returnTo = useEasyReturn()
  const { session, choosePurpose } = useEasy()

  const purpose = session.purpose

  if (gate) return gate
  if (!purpose) return null

  /* 検索条件（自由入力）はここで保存してから結果の画面へ渡す。目的は変えないので
     保存済みの候補は消えない（choosePurpose は目的が変わったときだけ捨てる）。
     実行した検索そのものはクエリ（?q=）に載せる — リロードでも共有リンクでも
     同じ結果に戻れるようにするため（通常モードの DomainSearchPage と同じ作法）。 */
  function handleSearch(label: string, note: string) {
    if (!purpose) return
    choosePurpose(purpose, note)
    navigate(easyNameResultsPath(label, returnTo))
  }

  return (
    <div className="space-y-6">
      <EasyStepNav backTo={returnTo ? easyStepDef(returnTo).path : easyStepDef('goal').path} />

      <EasyPageHeader title={NAME_HEADING} lede={NAME_LEDE} />

      <EasySearchForm
        defaultLabel={session.label}
        defaultNote={session.purposeNote}
        submitLabel={NAME_SEARCH_ACTION}
        showJargonNote
        onSearch={handleSearch}
      />
    </div>
  )
}
