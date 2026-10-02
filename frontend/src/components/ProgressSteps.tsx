/**
 * アプリ内で唯一の「進行中のフロー」表示。会員登録・DNS設定・かんたんモードの
 * 3 つのウィザードが同じ 1 本を使う。
 *
 * 形は「番号の四角 — 細い線 — ラベル」の横一列。3 状態の描き分けは
 *   完了 … 緑ベタ塗り＋白いチェック、線も太い緑（＝通った道）
 *   現在地 … いちばん濃い緑のベタ塗り＋若草の帯＋太字ラベル
 *   未到達 … 枠線だけの四角と控えめな文字
 * で、色を落としても「チェック / 数字」「帯の有無」で区別できる。
 *
 * ⚠️ 完了段はかつて `bg-primary/15`（15% 不透明の緑）だった。数字の代わりに
 * チェックは出ていても、薄すぎて「まだ終わっていない段」と見分けがつかない
 * という指摘が出た。完了はベタ塗りにして、現在地はさらに濃い緑＋帯で上に立てる。
 * 完了と現在地を「濃さ」だけで分けない（帯とラベルの太さも一緒に効かせる）。
 *
 * ⚠️ 以前は「かんたんモードだけ Progress ゲージ、ほかはチップ列」の 2 表現だった。
 * 同じアプリで進捗の見え方が 2 種類あると、初心者は別の仕組みだと受け取る。
 * 見た目の分岐はこのファイルの中だけに閉じ、呼び出し側は並びと現在地しか渡さない。
 *
 * `currentIndex` を呼び出し側が計算するのは、「全部完了」の表し方がフローごとに
 * 違うため（会員登録の 'complete' はステップ配列の外にある）。ここで id から
 * 引き直すと、その状態を表現できなくなる。
 *
 * ⚠️ 間隔・線幅・文字サイズは「かんたんモードの 7 段が 1 行に収まる」ことを
 * 上限として決めてある（2026-08-28、利用者の「7の公開完了も横一列に」という
 * 指摘による）。効いているのは **640px 幅の画面** で、ここが全体の設計を縛る:
 *   - かんたんモードの器は `max-w-[760px]` ＋ `sm:px-7` なので、`<ol>` が使える
 *     幅は 640px 画面で **584px**、768px 以上では **704px** で頭打ちになる。
 *     つまり画面をいくら広げても 704px より広くはならない。
 *   - 一方 640px 以上では全ラベルが出る。7 段のラベルは実測 241.6px
 *     （目的28 / 名前28 / 末尾28 / 確認28 / お支払い54.7 / つなぐ37.5 / 公開完了56、
 *     いずれも 13px 時）、四角が 7×24＝168px。**この 409.6px は削れない下限**。
 *   - 直す前は 794.1px 必要で 584px に入らず、7 段目だけが 2 行目に落ちていた。
 *
 * 実測（Chrome ヘッドレス, /easy/goal, prefers-color-scheme: light）:
 *   375px → 必要 324.00 / 使える 343（余り 19.00px、1 行）
 *   640px → 必要 565.57 / 使える 584（余り 18.43px、1 行）
 *   768px → 必要 685.57 / 使える 704（余り 18.43px、1 行）
 *  1280px → 必要 685.57 / 使える 704（余り 18.43px、1 行）
 * （「必要」は 7 段のどれを現在地にしても折り返さない最悪値。640px 以上では
 *  全段のラベルが出るので現在地がどこでも同じ値になる。）
 *
 * ⚠️ したがって **余白は 20px 弱しか残っていない**。段を 8 つに増やす、ラベルを
 * 1 文字でも伸ばす、四角や文字を大きくする、間隔を広げる — どれをやっても
 * 640px 幅で 2 行に折り返す。増やすなら、まず上の実測値をやり直すこと。
 * （ラベル文言は features/easy/easyTypes.ts と easyJourney.ts が持っている。）
 */
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ProgressStep = { readonly id: string; readonly label: string }

export function ProgressSteps({
  steps,
  currentIndex,
  label,
  align = 'start',
}: {
  steps: readonly ProgressStep[]
  /** 現在地の添字。steps.length を渡すと全段が完了として描かれる。 */
  currentIndex: number
  /** nav の読み上げ名（「登録の進行状況」など）。 */
  label: string
  align?: 'start' | 'center'
}) {
  return (
    <nav aria-label={label}>
      {/* flex-wrap は保険。7 段が 1 行に収まるよう幅を詰めてあるので通常は折れないが、
          将来ラベルが伸びたときに横スクロールを出すよりは折り返すほうがまだ良い。 */}
      <ol
        className={cn(
          'flex flex-wrap items-center gap-x-0.5 gap-y-2 md:gap-x-1',
          align === 'center' && 'justify-center',
        )}
      >
        {steps.map((step, index) => {
          const isDone = index < currentIndex
          const isCurrent = index === currentIndex

          return (
            <li key={step.id} className="flex min-w-0 items-center gap-0.5 md:gap-1">
              {/* 通った線は太く。細い 1px のままだと、ベタ塗りの段どうしが
                  つながって見えない。
                  ⚠️ 幅を広げると 640px で 7 段が折り返す。8px×6本＝48px が
                  640px 画面での持ち分で、24px に戻せるのは器が 704px まで
                  広がりきる 768px 以上だけ。 */}
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'w-2 rounded-none md:w-6',
                    isDone || isCurrent ? 'h-0.5 bg-primary' : 'h-px bg-border',
                  )}
                />
              ) : null}
              <span
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex min-w-0 items-center gap-1 rounded-none px-0.5 py-1 sm:px-1',
                  isCurrent && 'bg-grass-2 font-semibold text-green-darkest',
                  isDone && 'text-green-deep',
                  !isCurrent && !isDone && 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'font-en flex size-6 shrink-0 items-center justify-center rounded-none text-xs font-semibold',
                    isCurrent && 'bg-green-darkest text-green-contrast',
                    isDone && 'bg-primary text-primary-foreground',
                    !isCurrent && !isDone && 'border border-border text-muted-foreground',
                  )}
                >
                  {isDone ? <CheckIcon className="size-3.5" /> : index + 1}
                </span>
                {/* 読み上げには常にラベルを渡す。見た目だけ、狭い画面で現在地に畳む。
                    not-sr-only は white-space を戻すので truncate は効かない。
                    語中で折り返さないよう shrink-0 で縮ませない。
                    ⚠️ 13px 固定。以前は `sm:text-sm`（14px）に上げていたが、640px 幅では
                    7 段ぶんのラベルが 260.1px になり、四角と間隔を最小まで詰めても
                    584px に 10px 足りず折り返していた。13px なら 241.6px で収まる。
                    sr-only は position:absolute なので、畳まれた段は親の gap を
                    消費しない（狭い画面の見積りに 7 段ぶんの gap を数えないこと）。 */}
                <span className={cn('shrink-0 text-[13px]', !isCurrent && 'sr-only sm:not-sr-only')}>
                  {step.label}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
