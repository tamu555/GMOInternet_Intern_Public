/**
 * 各ステップの共通操作。**画面の上下で役割を分けている**。
 *
 * 上部 = 戻り (`EasyStepNav`): 「戻る」だけ。
 * 下部 = 進む (`EasyStepActions`): その画面でやることを終えたあとに押す「次へ」。
 * 読み終えた位置のすぐ下にあるべきなので、ここは動かさない。
 *
 * 押すべきボタンが一目で分かるよう、**塗りのボタンは「次へ」1 つだけ**。
 * 「戻る」は補助操作なのでテキストリンクに落として重みを下げる。
 * モバイルでは主要ボタンだけ全幅にして押しやすくする。
 *
 * ⚠️ この行にあった 3 本は 2026-08-28 にすべて廃止した。理由はどれも同じで、
 * **トップページへ戻れば済む**から:
 *   - 「保存してあとで続ける」… 行き先がトップページなのに、そのトップページが
 *     下書きを破棄する（`clearEasyDrafts`）ので、「保存した」と言いながら消す
 *     操作になっていた。
 *   - 「通常モードに切り替える」… ヘッダーのブランドリンクがトップページ＝通常
 *     モードの入口で、そこには本文に大きい切り替え（`EasyModeSwitch`）がある。
 *   - 「入力内容を消して最初からやり直す」… トップページを踏んだ時点で下書きは
 *     破棄されるので、専用の破壊的操作を 1 本置く理由が無くなった。
 * 補助リンクを 4 本並べると、どれが「進む」なのかが読み取れなくなる。残すのは
 * 1 つ前の画面へ帰る「戻る」だけにする。
 */
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ACTION_BACK, ACTION_NEXT } from './easyMessages'

const SUBTLE_LINK = 'h-auto p-0 text-[13px] font-medium text-muted-foreground'

/**
 * ステップ上部の「戻る」。各ステップのページの**いちばん上**に置く。
 *
 * 「次へ」と同じ行に混ぜないのは、進む操作と抜ける操作を取り違えさせないため。
 * 1 ステップ目のように帰る先が無い画面では、この行ごと出さない（`backTo` 無し）。
 */
export function EasyStepNav({ backTo }: { backTo?: string }) {
  if (!backTo) return null

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border pb-3">
      <Button variant="link" className={SUBTLE_LINK} asChild>
        <Link to={backTo}>
          <ArrowLeft aria-hidden="true" />
          {ACTION_BACK}
        </Link>
      </Button>
    </div>
  )
}

/** ステップ下部の主要操作。塗りのボタン「次へ」だけを持つ。 */
export function EasyStepActions({
  nextLabel = ACTION_NEXT,
  onNext,
  nextDisabled = false,
  busy = false,
  hideNext = false,
}: {
  nextLabel?: string
  onNext?: () => void
  nextDisabled?: boolean
  busy?: boolean
  hideNext?: boolean
}) {
  if (hideNext) return null

  return (
    <div className="mt-8 border-t border-border pt-5">
      <Button
        type="button"
        size="lg"
        className="w-full sm:w-auto sm:min-w-56"
        onClick={onNext}
        disabled={nextDisabled || busy}
      >
        {busy ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            処理中…
          </>
        ) : (
          <>
            {nextLabel}
            <ArrowRight aria-hidden="true" />
          </>
        )}
      </Button>
    </div>
  )
}

/** 各ステップの見出し。DESIGN_SYSTEM のページヘッダーパターンに合わせる。 */
export function EasyPageHeader({ title, lede }: { title: string; lede?: string }) {
  return (
    <header className="space-y-1.5">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {lede ? <p className="text-sm leading-relaxed text-muted-foreground">{lede}</p> : null}
    </header>
  )
}
