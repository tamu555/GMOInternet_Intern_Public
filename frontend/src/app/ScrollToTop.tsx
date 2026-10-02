/**
 * ルート遷移時のスクロール位置リセット（issue #83）。
 *
 * React Router の BrowserRouter はスクロール位置を一切管理しないので、SPA 遷移
 * では前のページのスクロール位置がそのまま残る。遷移先が短いページだと、本文の
 * 途中どころか本文より下（＝何も無い領域）が表示され、「ヘッダーが画面の中央に
 * 浮いている」「真っ白」に見える。さらに悪いのは、押した直後に再レイアウトが
 * 起きて別の要素がカーソルの下に来ること — 実際に「Vercel を押したのに
 * さくらのレンタルサーバが選ばれた」という誤クリックが起きていた（issue #90 の
 * 「初回クリックが無視される」も、その多くはこれと同じ過渡状態）。
 *
 * ⚠️ `useEffect` ではなく **`useLayoutEffect`** を使うこと。useEffect は
 * 描画のあとに走るので、前の位置で 1 フレーム描いてからスクロールが飛ぶ。
 * その 1 フレームこそが上の「崩れて見える」「押し間違える」の正体なので、
 * ペイント前に確定させる必要がある。
 *
 * ⚠️ 「戻る／進む」（POP）では動かさない。同一ドキュメント履歴のスクロール復元は
 * ブラウザ（history.scrollRestoration = 'auto'）が持っており、そこへ割り込むと
 * 長い検索結果から戻ってきた人が毎回いちばん上に飛ばされる。issue が挙げている
 * 実害はすべて前進方向（PUSH / REPLACE）の遷移。
 */
import { useLayoutEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/** ページ内アンカー（フッターの `/#tlds` など）はその要素まで送る。 */
function scrollToHash(hash: string): boolean {
  const id = hash.slice(1)
  if (!id) return false
  const target = document.getElementById(id)
  if (!target || typeof target.scrollIntoView !== 'function') return false
  target.scrollIntoView()
  return true
}

export function ScrollToTop() {
  const { pathname, hash } = useLocation()
  const navigationType = useNavigationType()

  useLayoutEffect(() => {
    if (navigationType === 'POP') return
    try {
      if (scrollToHash(hash)) return
      window.scrollTo({ top: 0, left: 0 })
    } catch {
      /* jsdom には scrollTo / scrollIntoView の実装が無い（テストでは何もしない）。 */
    }
    // hash だけが変わる遷移（同じページ内のアンカー）でも走らせたいので hash も依存に入れる。
  }, [pathname, hash, navigationType])

  return null
}
