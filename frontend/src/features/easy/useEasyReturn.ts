/**
 * 「確認画面から修正しに来た」という文脈を URL に載せるための小さな仕組み。
 *
 * ウィザードは原則として一本道で、各ステップの「次へ」は常に 1 つ先へ進む。
 * その唯一の例外が、内容の確認（4/6）にある「変更」から名前・末尾・使いみちへ
 * 戻ってくる導線。ここで通常どおり 1 つずつ進ませると、1 項目直したいだけの人が
 * ウィザードを最後まで歩き直すことになる。
 *
 * 文脈を React の state ではなく `?return=confirm` という**クエリパラメータ**で
 * 持つのは、リロードやブラウザの「戻る」でも消えないようにするため。state に
 * 置くと、修正の途中で画面を再読み込みした瞬間に「どこへ帰るか」を見失う。
 */
import { useSearchParams } from 'react-router-dom'
import { EASY_NAME_RESULTS_PATH, EASY_STEPS, easyStepDef, type EasyStepId } from './easyTypes'

/** クエリの `return` を読む。ステップ id として解釈できないものは null（＝通常の一本道）。 */
export function useEasyReturn(): EasyStepId | null {
  const [searchParams] = useSearchParams()
  const raw = searchParams.get('return')
  // 手で書き換えられた URL でも壊れないよう、必ず EASY_STEPS と突き合わせる。
  const match = EASY_STEPS.find((step) => step.id === raw)
  return match?.id ?? null
}

/**
 * ステップの遷移先 URL に、戻り先の文脈を付けて返す。
 * `returnTo` が null なら通常の一本道なので、パスはそのまま（余計なクエリを残さない）。
 */
export function easyStepPathWithReturn(step: EasyStepId, returnTo: EasyStepId | null): string {
  const path = easyStepDef(step).path
  return returnTo ? `${path}?return=${returnTo}` : path
}

/**
 * 検索結果（/easy/name/results）の URL。
 *
 * 実行した検索は通常モードの `?q=` と同じくクエリに載せる（DomainSearchPage の
 * 冒頭コメント）。リロードでも共有リンクでも、同じ検索をやり直せば同じ結果に
 * 戻れるのがこの形の値打ちで、結果そのものを画面の state に閉じ込めない。
 * `seed` に null を渡すと q を付けない ＝「前回の検索結果をそのまま見る」。
 */
export function easyNameResultsPath(seed: string | null, returnTo: EasyStepId | null): string {
  const params = new URLSearchParams()
  if (seed !== null) params.set('q', seed)
  if (returnTo) params.set('return', returnTo)
  const query = params.toString()
  return query ? `${EASY_NAME_RESULTS_PATH}?${query}` : EASY_NAME_RESULTS_PATH
}
