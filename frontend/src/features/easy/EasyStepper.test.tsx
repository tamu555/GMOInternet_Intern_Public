/**
 * 進捗バーの契約。見た目のクラス名ではなく「何が描かれ、どこに置かれているか」
 * を見る。
 *
 * ⚠️ この回（2026-08-28、利用者の指摘）で守りたいのは 3 つ。
 *   1. 到達点（⑦公開完了）が**段の列の中**に、ほかの 6 段と同じ形で出ること。
 *      四角の中身は番号にそろえる — 6 段が数字で 7 段目だけ旗、という状態が
 *      「並びとして読めない」という指摘の中身だった。
 *   2. 到達点は現在地にも完了にもならないこと（`aria-current` はちょうど 1 個、
 *      到達点の四角は最後まで「7」のまま）。押して進む操作ではない。
 *   3. かつてバーの直後に常設していたゴール行（「ゴール：あなたのサイトが〜」）を
 *      出さないこと（2026-08-28、全ステップに毎回出るのはくどい、という利用者の
 *      指摘で削除）。
 * あわせて「つなぐ」の段だけに出る別名の 1 行も、ここで縛る。
 *
 * ⚠️ 全体図（EasyJourneyMap / 「サイト公開までの全体図を見る」）は同日に廃止した。
 * 復活させるなら、進捗表示が縦に何層になるかを測ってから決めること。
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EasyStepper } from './EasyStepper'
import { EASY_CONNECT_ALIAS_NOTE, EASY_GOAL_STEP_LABEL } from './easyJourney'
import { EASY_STEPS } from './easyTypes'

/** ProgressSteps が描く nav。名前は easyModeFlow.test.tsx が完全一致で引く。 */
function stepperNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'かんたんモードの進行状況' })
}

/** バーの段（到達点を含む）。 */
function steps(): HTMLElement[] {
  return within(stepperNav()).getAllByRole('listitem')
}

/** 到達点の段。並びの最後にある。 */
function goalStep(): HTMLElement {
  const all = steps()
  return all[all.length - 1]
}

describe('EasyStepper', () => {
  it('到達点は段の列の最後に、ほかの段と同じ形で並ぶ', () => {
    render(<EasyStepper current="tld" />)

    // 6 つの操作ステップ ＋ 到達点 = 7 段。
    expect(steps()).toHaveLength(EASY_STEPS.length + 1)
    expect(goalStep()).toHaveTextContent(EASY_GOAL_STEP_LABEL)
  })

  it('到達点の四角の中身は、ほかの段と同じ番号（旗やアイコンにしない）', () => {
    render(<EasyStepper current="tld" />)

    const goal = goalStep()
    // 7 段目なので「7」。⚠️ ここが数字でなくなると、6 段が数字・1 段だけ図形、
    // という「並びとして読めない」状態に戻る。
    expect(goal).toHaveTextContent(String(EASY_STEPS.length + 1))
    expect(goal.querySelector('svg')).toBeNull()
  })

  it('到達点は現在地にも完了にもならない（押して進む操作ではない）', () => {
    const { rerender } = render(<EasyStepper current="goal" />)

    for (const step of EASY_STEPS) {
      rerender(<EasyStepper current={step.id} />)
      // 最後のステップ（つなぐ）に居ても、到達点は番号のまま＝未到達。
      expect(goalStep()).toHaveTextContent(String(EASY_STEPS.length + 1))
      expect(goalStep().querySelector('svg')).toBeNull()
      expect(goalStep().querySelector('[aria-current="step"]')).toBeNull()
      // 現在地はつねに 1 つだけ。
      expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
    }
  })

  it('完了した段はチェックに変わる（到達点は変わらない）', () => {
    render(<EasyStepper current="tld" />)

    const all = steps()
    // 目的・名前は完了 → チェック。
    expect(all[0].querySelector('svg.lucide-check')).not.toBeNull()
    expect(all[1].querySelector('svg.lucide-check')).not.toBeNull()
    // 末尾は現在地 → 番号のまま。
    expect(all[2]).toHaveTextContent('3')
  })

  it('削除済みのゴール行（「ゴール：〜」）を出さない', () => {
    render(<EasyStepper current="tld" />)

    expect(screen.queryByText(/^ゴール：/)).toBeNull()
  })

  it('「つなぐ」の段でだけ、つなぐ設定 = DNS設定 だと折りたたみの外で言う', () => {
    const { rerender } = render(<EasyStepper current="dns" />)

    const note = screen.getByText(EASY_CONNECT_ALIAS_NOTE)
    expect(note).toBeInTheDocument()
    // 折りたたみの中ではなく、常時見えている場所にあること（疑問は開く前に起きる）。
    expect(note.closest('[data-state="closed"]')).toBeNull()
    expect(stepperNav().contains(note)).toBe(false)

    for (const step of EASY_STEPS.filter((entry) => entry.id !== 'dns')) {
      rerender(<EasyStepper current={step.id} />)
      expect(screen.queryByText(EASY_CONNECT_ALIAS_NOTE)).toBeNull()
    }
  })
})
