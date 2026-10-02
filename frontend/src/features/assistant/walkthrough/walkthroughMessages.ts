/**
 * Japanese UI copy for the Guided Walkthrough feature
 * (`.agents/docs/research/assistant-walkthrough-plan.md` §4, spec browser-ai.md
 * §13.2/§30). Kept in its own module rather than added to `assistantMessages.ts`
 * (owned by a concurrent wave this phase - see the wave assignment) so both
 * files can be edited in parallel with no merge conflict. Mirrors
 * `assistantMessages.ts`'s own convention: every user-facing string this
 * feature's UI needs lives here, nowhere else.
 *
 * Two labels ARE imported from `assistantMessages.ts` rather than restated: a
 * walkthrough step that navigates and a walkthrough step that searches for
 * domains do exactly what the Navigation Card and the SUGGEST_DOMAINS Quick
 * Action do, and wording the same journey two different ways is the drift
 * §14.2 「二重定義を作らない」 rules out.
 */
import { navigationCtaLabel, SUGGEST_DOMAINS_ACTION_LABEL } from '../assistantMessages'
import type { WalkthroughStepAction } from './walkthroughTemplates'

/** `WalkthroughStepper`'s `<nav aria-label>` (full) / accessible name (compact) - mirrors `SignupStepper`'s "登録の進行状況". */
export function walkthroughStepperAriaLabel(templateTitle: string): string {
  return `${templateTitle}の進行状況`
}

/** Compact stepper's "n/m" progress readout. */
export function walkthroughCompactProgressLabel(completedCount: number, totalCount: number): string {
  return `${completedCount}/${totalCount}`
}

/** `AssistantModal`'s pinned-stepper expand/collapse toggle (kept small so the stepper cannot eat the modal's height). */
export const WALKTHROUGH_STEPPER_COLLAPSE_LABEL = '手順をたたむ'
export const WALKTHROUGH_STEPPER_EXPAND_LABEL = '手順を表示する'

/** `WalkthroughCard`'s warning `Alert` heading - mirrors `NAVIGATION_CARD_WARNINGS_LABEL`. */
export const WALKTHROUGH_CARD_WARNINGS_LABEL = '注意'

/**
 * `WalkthroughCard`'s manual-completion control. Deliberately honest about
 * what the app can and cannot see: a `visited-route` step is confirmed by the
 * app itself, but a `manual` step's work happens on another company's own
 * site/dashboard, which this app has no way to observe - the label says so
 * rather than implying the app verified anything.
 */
export const WALKTHROUGH_MANUAL_COMPLETION_LABEL =
  '完了にする（この操作はこのアプリからは確認できません。ご自身で確認できたらチェックしてください）'

/**
 * `WalkthroughCard`'s current-step action button, labelled by what the button
 * actually DOES.
 *
 * ⚠️ This used to be `${stepTitle}へ進む` - `navigationCtaLabel`'s template
 * applied to a step title. That template is written for a NOUN (a screen name:
 * 「ドメイン検索へ進む」), but every step title is a VERB PHRASE, so it produced
 * ungrammatical Japanese for all of them - 「ドメインを用意する**へ進む**」,
 * 「レコード設定画面を開く**へ進む**」 - and, worse, promised navigation on the
 * steps whose action is `OPEN_DOC`, which navigates nowhere at all (it surfaces
 * documentation; see `AssistantModal`'s `handleRunStepAction`). The reported
 * one was 「サービス側で設定値を確認する**へ進む**」.
 *
 * A NAVIGATE step now names its DESTINATION, which is what
 * `navigationCtaLabel`'s template was always for - and the label is built with
 * that same function, so the walkthrough's button and the Navigation Card's
 * button cannot word the same journey differently.
 */
export function walkthroughStepActionLabel(action: WalkthroughStepAction, routeTitle: string | null): string {
  switch (action.kind) {
    case 'NAVIGATE':
      // `null` only when the RouteId is absent or missing from the Manifest -
      // the same condition under which `handleRunStepAction` declines to
      // navigate, so the label must not name a destination either.
      return routeTitle === null ? WALKTHROUGH_STEP_GENERIC_NAVIGATE_LABEL : navigationCtaLabel(routeTitle)
    case 'OPEN_DOC':
    case 'RUN_WEB_SEARCH':
      return WALKTHROUGH_STEP_OPEN_DOC_LABEL
    case 'SUGGEST_DOMAINS':
      return SUGGEST_DOMAINS_ACTION_LABEL
  }
}

/**
 * OPEN_DOC/RUN_WEB_SEARCH steps. Deliberately says 表示する, not 進む or 開く:
 * the click neither navigates nor opens an external site by itself - it renders
 * the §32 cards (a curated link, or the allowlisted search-query card), and the
 * user still chooses whether to follow one.
 */
export const WALKTHROUGH_STEP_OPEN_DOC_LABEL = '参考ページを表示する'

/** NAVIGATE with an unresolvable RouteId - names no destination, because none can be named. */
export const WALKTHROUGH_STEP_GENERIC_NAVIGATE_LABEL = 'この手順の画面へ進む'

/** `WalkthroughCard`'s always-available "give up" link (plan §5: "やめる" - progress is preserved, so it can resume later). */
export const WALKTHROUGH_DISMISS_BUTTON_LABEL = 'やめる'

/** `WalkthroughCard`'s all-steps-complete state. */
export const WALKTHROUGH_COMPLETE_TITLE = 'すべての手順が完了しました'
export const WALKTHROUGH_COMPLETE_DESCRIPTION = 'お疲れさまでした。この案内はここで終了です。'
export const WALKTHROUGH_CLOSE_BUTTON_LABEL = '閉じる'

/**
 * §34 / §30 rule 0: the Quick Action that starts a walkthrough from a chat
 * turn. Names the concrete goal so the user knows what they are opting into,
 * rather than a generic 「手順を見る」.
 */
export function startWalkthroughActionLabel(templateTitle: string): string {
  return `${templateTitle}手順を見ながら進める`
}

/**
 * The same walkthrough button, relabelled for the case where the message it is
 * attached to is ASKING the user to pick a required slot value they may not
 * have (`actions.ts`'s `startWalkthroughActions`).
 *
 * The reported dead end: 「ドメインを取得したが公開のために何をすれば良い」 is answered
 * with 「どのサービスでWebサイトを公開しますか？」 and seven hosting-company buttons -
 * a question a beginner who has only just bought a domain usually cannot answer,
 * with no visible way past it. The walkthrough was already offered in that same
 * message, but under a label ("…手順を見ながら進める") that reads as an optional
 * extra rather than as an answer to the question just asked. Only the wording
 * changes; it is the same button, the same template, and the same click.
 */
export const WALKTHROUGH_UNDECIDED_ACTION_LABEL = 'まだ決まっていない（順番に案内してもらう）'
