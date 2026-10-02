/**
 * かんたんモードのシェル（仕様 §1.2「新規に作るのはシェルだけ」）。
 *
 * ここが持つのは 2 つだけ:
 *   1. EasyProvider を 1 回だけマウントする（ステップ間で入力が失われない）
 *   2. 進捗ステッパーを常時表示する（現在地が分かる）
 *
 * モード名はここでは名乗らない。名乗っても現在地の役には立たず、進捗の行に
 * 並べると 6 段が 2 行に折り返すだけになる。モード名の表示と「通常モードに戻る」
 * 出口は、sticky なヘッダー（`app/AppLayout.tsx` の `isEasyMode` の区画）が
 * 持つ — ステップ本文の下部に置いていた頃は、一番下まで下りないと戻れなかった
 * （issue #91）。ここにも各ステップの操作行にも、切り替えのリンクは置かない。
 *
 * 画面の中身は各ステップのページが持ち、フォーム部品は既存の通常モードの
 * コンポーネントをそのまま使う。
 */
import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../auth/useAuth'
import { FullPageLoader } from '../../components/FullPageLoader'
import { EasyProvider } from './EasyProvider'
import { EasyStepper } from './EasyStepper'
import { EASY_DONE_PATH, EASY_STEPS, type EasyStepId } from './easyTypes'

function stepFromPathname(pathname: string): EasyStepId {
  const match = EASY_STEPS.find((step) => pathname.startsWith(step.path))
  // /easy と /easy/done はステッパーに無い画面（入口と到達点）。
  // 読み幅の解決にだけ最後のステップを使う。
  return match?.id ?? EASY_STEPS[EASY_STEPS.length - 1].id
}

/**
 * ウィザードの読み幅は 760px。問いかけと選択肢を読ませる画面はこれが上限で、
 * 広げると 1 行が長くなって読みにくくなる。
 *
 * 例外は末尾を選ぶ 3/6 だけ。ここは 22 件の末尾を「1画面で見比べる」画面なので
 * （通常モードの結果一覧と同じ役目）、読み幅ではなく一覧の幅が要る。760px だと
 * セルが 6 列で 4 段に折り返し、画面の右半分が空いたまま縦に伸びる。
 */
const STEP_MAX_WIDTH: Partial<Record<EasyStepId, string>> = {
  tld: 'max-w-[1060px]',
}
const DEFAULT_MAX_WIDTH = 'max-w-[760px]'

function EasyShell() {
  const location = useLocation()
  const current = stepFromPathname(location.pathname)
  /* ステッパーを出さない 2 画面。
     - /easy/done … ステップではなく到達点。出すと「6/6 つなぐ設定」と名乗って
       しまい、DNSを飛ばした人には事実ですらない（つなぐ設定はしていない）。
     - /easy … ステップではなく入口（続きから進むか、やり直すかを選ぶ画面。
       issue #91）。どのステップにも一致しないので `stepFromPathname` は最後の
       ステップに落ちる — そのまま出すと、まだ何も始めていない人にいきなり
       「6/6 つなぐ」を現在地として見せることになる。 */
  const isStepless =
    location.pathname.startsWith(EASY_DONE_PATH) ||
    !EASY_STEPS.some((step) => location.pathname.startsWith(step.path))

  /* ⚠️ ここにあったスクロールリセットは `app/ScrollToTop.tsx` へ移した
     （2026-08-28, issue #83）。useEffect だったため描画のあとに走り、前の
     スクロール位置で 1 フレーム描いてから飛んでいた — その 1 フレームが
     「ヘッダーが中央に浮く」「押した先が入れ替わる」の正体だったので、
     シェル側で useLayoutEffect（ペイント前）に統一している。
     ここに書き戻さないこと。通常モードにも同じ規則が要る。 */

  return (
    <div
      className={`mx-auto w-full px-4 pt-6 pb-24 transition-[max-width] sm:px-7 lg:pt-10 ${
        STEP_MAX_WIDTH[current] ?? DEFAULT_MAX_WIDTH
      }`}
    >
      {/* シェルが出すのは進捗だけ。説明文と「通常モードに戻れます」のチップは、
          各ステップの問いかけより先に読ませる価値がないので置かない。 */}
      {isStepless ? null : (
        <div className="mb-7">
          <EasyStepper current={current} />
        </div>
      )}

      {/* ステップの切り替わりを「スッと」見せる。key にパスを入れているのが要で、
          パスが変わるたびに中身がマウントし直され、enter アニメーションが
          もう一度走る（key が同じだと初回しか動かない）。
          動きを減らす設定の人には app.css の prefers-reduced-motion が効く。 */}
      <div
        key={location.pathname}
        className="animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out"
      >
        <Outlet />
      </div>
    </div>
  )
}

export function EasyLayout() {
  const { state } = useAuth()

  /* セッション確認が終わるまで待つ（FIG.7 と同じ三状態の作法）。
     待たずに描くと、下書きの保存スコープがまだ 'guest' のまま解決されるため、
     ログイン済みの人が /easy/tld のような深いリンクを直接開いたときに
     「入力が無い」と判定され、ステップ1へ差し戻されてしまう。 */
  if (state.status === 'checking') {
    return <FullPageLoader message="ログイン状態を確認しています…" />
  }

  return (
    <EasyProvider>
      <EasyShell />
    </EasyProvider>
  )
}
