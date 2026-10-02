/**
 * つなぎ先が決まるまでの入口（?mode= が付く前）の進行役。
 *
 *   使いみちを選ぶ (DnsGoalStep)
 *     ├ ホームページ / メール → 案内の見分け (DnsModeChoiceStep) → mode 確定
 *     └ まだ何も用意していない → 準備の案内 (DnsPrepareStep)
 *
 * 進行表示は「つなぎ先を決める」1歩目として goal / evidence の両方で出す。
 * 準備の案内だけは出さない — あれは前へ進む画面ではなく、いったん離れて
 * サービスを用意しに行く画面で、進行バーを出すと進捗の途中に見えてしまう。
 */
import { DNS_INTRO_STEPS, DNS_MODE_STEP } from './dnsEditorSteps'
import type { DnsGoal } from './dnsGoal'
import { DnsGoalStep } from './DnsGoalStep'
import type { DnsMode } from './dnsMode'
import { DnsModeChoiceStep } from './DnsModeChoiceStep'
import { DnsPrepareStep } from './DnsPrepareStep'
import { DnsStepper } from './DnsStepper'

export function DnsEntryFlow({
  domainName,
  goal,
  onSelectGoal,
  onSelectMode,
}: {
  domainName: string
  /** 未回答なら null。URL の ?goal= に載るので戻る・リロードで維持される。 */
  goal: DnsGoal | null
  onSelectGoal: (goal: DnsGoal | null) => void
  onSelectMode: (mode: DnsMode) => void
}) {
  if (goal === 'none') {
    return (
      <DnsPrepareStep domainName={domainName} onBackToGoal={() => onSelectGoal(null)} />
    )
  }

  return (
    <>
      <DnsStepper steps={DNS_INTRO_STEPS} current={DNS_MODE_STEP.id} />
      {goal === null ? (
        <DnsGoalStep domainName={domainName} onSelect={onSelectGoal} />
      ) : (
        <DnsModeChoiceStep goal={goal} onSelect={onSelectMode} onBackToGoal={() => onSelectGoal(null)} />
      )}
    </>
  )
}
