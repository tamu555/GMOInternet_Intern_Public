/**
 * かんたんモードの進行状況。**画面上部に縦 2 層**で置く。
 *
 *   1. 7 段のバー（{@link ProgressSteps}）… いま何番目か、そして到達点
 *   2. 別名の 1 行（{@link EASY_CONNECT_ALIAS_NOTE}）… 「つなぐ」の段でだけ
 *
 * 表示は共有の {@link ProgressSteps}（会員登録・DNS設定と同じ 1 本）。以前は
 * ここだけが Progress のゲージ＋「1/6」「のこり5ステップ」という別表現で、同じ
 * アプリの中に進捗の見え方が 2 種類あった。番号つきの段に統一すると、いま何番目
 * かに加えて「この先に何が待っているか」も一目で読めるようになる。
 *
 * そのステップが何のためかは各ページの見出しが言うので、ここでは繰り返さない。
 * 完了ステップへ戻る導線は各ステップの操作行の「戻る」が担う。
 *
 * ⚠️ 到達点（⑦公開完了）は、ほかの 6 段と**同じ形・同じ中身の種類**で出すこと
 * （2026-08-28、利用者の指摘による）。四角の中身は番号にそろえる。
 *
 * これは同日の前案を差し戻したもので、経緯を残しておく。前案は到達点を段の列から
 * 外し、破線＋裸の旗＋文の独立した 1 行にしていた。理由は実測値で、かんたんモードの
 * 読み幅 760px（内容 704px）に対して 6 段だけで 656px を使い、破線＋チップの 94px が
 * 入らず折り返していた、というもの。ただし折り返しそのものは壊れではない
 * （{@link ProgressSteps} の `<ol>` は `flex-wrap` で、7 段目だけが 2 行目へ落ちる）。
 * 実際に読めなくしていたのは、**四角の中身が段ごとに違ったこと** — 6 段は数字、
 * 7 段目だけ 14px の旗アイコン、しかも 640px 未満ではラベルが `sr-only` に畳まれて
 * 破線の四角だけが残る、という状態だった。数字にそろえた今は、2 行目に落ちても
 * 「⑦」と読めるので、その失敗は再現しない。
 *
 * ⚠️ ただし到達点は「押せば公開される 7 番目の操作」ではない。かつてはバーの
 * 直後に「ゴール：あなたのサイトが見られるようになること」という言い直しの
 * 1 行を常設していたが、全ステップに毎回出るのはくどい、という利用者の指摘で
 * 削除した（2026-08-28）。戻さないこと。⑦の意味は、ラベルが操作ではなく状態の
 * 名前（公開完了）であること・現在地にも完了にもならないことが担い、
 * 「公開＝3つの部品」の説明は完了画面のチェックリスト（easyJourney.ts の
 * EASY_DONE_JOURNEY_HEADING 以下）が引き受ける。
 *
 * ⚠️ `label="かんたんモードの進行状況"` を変えない。easyModeFlow.test.tsx が
 * 完了画面で「この nav が無いこと」を、この文字列の完全一致で確かめている。
 *
 * ⚠️ この行にドメイン名を出さない。取得するドメイン名は確認・支払い・完了の
 * 各画面に大きく出ており、進捗バーにも出すと同じ画面に同じ文字列が 2 か所現れる
 * （easyModeFlow.test.tsx の `getByText('my-bakery.com')` が単数形で落ちる）。
 *
 * ⚠️ この行にモード名のバッジを同居させない。かんたんモードに居ることは
 * URL と画面全体が既に言っており、バッジのぶんだけ段が 2 行に折り返す。
 */
import { InfoIcon } from 'lucide-react'
import { ProgressSteps } from '../../components/ProgressSteps'
import { EASY_CONNECT_ALIAS_NOTE, EASY_GOAL_STEP_LABEL } from './easyJourney'
import { EASY_STEPS, easyStepIndex, type EasyStepId } from './easyTypes'

/**
 * バーの最後に足す到達点。
 *
 * ⚠️ {@link EASY_STEPS} 本体には足さない。あちらは「進める操作」の一覧で、
 * ルート・認証要否・完了判定がぶら下がっている。ここは表示だけの 1 段なので、
 * 進捗バーへ渡すときにだけ継ぎ足す。`currentIndex` は 0〜5 のままなので、
 * この段が現在地や完了になることはない。
 */
const EASY_GOAL_STEP = { id: 'published', label: EASY_GOAL_STEP_LABEL } as const
const EASY_STEPS_WITH_GOAL = [...EASY_STEPS, EASY_GOAL_STEP] as const

export function EasyStepper({ current }: { current: EasyStepId }) {
  return (
    <div className="space-y-2">
      <ProgressSteps
        steps={EASY_STEPS_WITH_GOAL}
        currentIndex={easyStepIndex(current)}
        label="かんたんモードの進行状況"
      />

      {/* 「つなぐ」の段でだけ、その段の名前と画面上の用語が同じものだと言う。
          常時出すと進捗の行が 1 段厚くなるので、必ずこのステップ限定にする。 */}
      {current === 'dns' ? (
        <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted-foreground">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>{EASY_CONNECT_ALIAS_NOTE}</span>
        </p>
      ) : null}
    </div>
  )
}
