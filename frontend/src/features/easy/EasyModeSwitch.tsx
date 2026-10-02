/**
 * 「通常モード / かんたんモード」の切り替え。トップページの本文に置く、
 * かんたんモードへの唯一の入口。現在地はトップ（＝通常モード）なので通常側は
 * 選択済みの表示になり、かんたん側だけがリンクになる。
 *
 * ⚠️ ヘッダーのバーには置かない（2026-08-28）: 一時期ヘッダーにも小さい
 * 切り替えを常時出していたが、行き先リンク（マイページ）と同じ 1 組の選択肢に
 * 見えてしまい、いま自分がどちらのモードに居るのかがかえって読めなくなった。
 * バーに出すのは行き先だけ、モードの切り替えは本文のこれ 1 つが持つ。
 *
 * かんたんモードから通常モードへ戻る導線は、ヘッダーのブランドリンクと
 * フッター（どちらもトップ = 通常モードへ行く）。ヘッダーに出していた現在地
 * バッジ＋「通常モードに戻る」出口（issue #91）も、各ステップ本文の
 * 「通常モードに切り替える」も 2026-08-28 に廃止した — 前者はバーに
 * 通常/かんたんの文字が並ぶこと自体が余計だという利用者の指摘、後者は
 * 一番下まで下りないと見えないため。トップへ戻ると入力途中の下書きは破棄される
 * （`clearEasyDrafts`）ので、やり直しの導線も兼ねる。
 *
 * 未ログインでも押せる — ログインが必要になるのは契約内容の確認ステップからで、
 * そこまでの入力は保存される。
 */
import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { EASY_MODE_LABEL, NORMAL_MODE_LABEL } from './easyMessages'

const GROUP_LABEL = 'モードの切り替え'

export function EasyModeSwitch({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div
        role="group"
        aria-label={GROUP_LABEL}
        className="inline-flex flex-wrap items-center gap-1 rounded-none bg-card/80 p-1 shadow-soft"
      >
        <span
          aria-current="page"
          className="rounded-none bg-grass-2 px-4 py-1.5 font-heading text-[13px] font-bold text-green-darkest"
        >
          {NORMAL_MODE_LABEL}
        </span>
        <Link
          to="/easy"
          className="flex items-center gap-1.5 rounded-none px-4 py-1.5 font-heading text-[13px] font-bold text-muted-foreground no-underline transition-colors hover:bg-grass-1 hover:text-green-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          {EASY_MODE_LABEL}
        </Link>
      </div>
    </div>
  )
}
