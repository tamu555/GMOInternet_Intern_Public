/**
 * Guided Walkthrough progress bar (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §4.1, spec browser-ai.md §13.2/§34). Built in the exact visual language of
 * `features/signup/SignupStepper.tsx` per the user's own request ("メールアドレス
 * ＋パスワードでの新規登録の時のような" progress bar): the same `<nav aria-label>`/
 * `<ol>` structure, connector spans, numbered circle -> `CheckIcon` once done,
 * `aria-current="step"` on the active step, and label collapsing to `sr-only`
 * on narrow screens for every step but the current one.
 *
 * Unlike `SignupStepper` (which derives everything from one fixed
 * `SignupStepId`), done/current here are derived per-step from
 * `walkthroughState.ts`'s `isStepComplete`/`currentStepIndex` - NEVER from a
 * stored index - so a step completed out of order (a manual override) still
 * renders correctly.
 *
 * Two render targets share this one component (plan §4.1):
 * - `variant="full"` (the default): the multi-step row above, used pinned
 *   inside `AssistantModal`.
 * - `variant="compact"`: a single line (title + "n/m" + a thin `Progress`
 *   bar) for the out-of-modal bar `AppLayout` renders while the walkthrough
 *   modal is closed. When `onOpenAssistant` is supplied the whole line is a
 *   button that reopens the assistant (`AppLayout`'s use); omitted, it is a
 *   plain, non-interactive summary (e.g. the collapsed state inside the
 *   modal itself, where clicking would be redundant - the modal is already
 *   open).
 */
import { useEffect, useRef } from 'react'
import { CheckIcon } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { WalkthroughState } from './types'
import { currentStepIndex, isStepComplete, progressRatio } from './walkthrough/walkthroughState'
import type { WalkthroughTemplate } from './walkthrough/walkthroughTemplates'
import { walkthroughCompactProgressLabel, walkthroughStepperAriaLabel } from './walkthrough/walkthroughMessages'

export interface WalkthroughStepperProps {
  template: WalkthroughTemplate
  state: WalkthroughState
  /** Compact bar used outside the modal; full labels inside it. Defaults to 'full'. */
  variant?: 'full' | 'compact'
  /** Compact variant only: clicking the bar reopens the assistant. */
  onOpenAssistant?: () => void
}

export function WalkthroughStepper({ template, state, variant = 'full', onOpenAssistant }: WalkthroughStepperProps) {
  // Both hooks run before the `compact` early return: React requires an
  // identical hook order on every render, and `variant` can change between
  // renders (`AssistantModal` swaps variants when the stepper is collapsed).
  const activeIndex = currentStepIndex(template, state)
  const currentStepRef = useCurrentStepInView(activeIndex)

  if (variant === 'compact') {
    return <CompactWalkthroughStepper template={template} state={state} onOpenAssistant={onOpenAssistant} />
  }

  return (
    <nav aria-label={walkthroughStepperAriaLabel(template.title)}>
      {/*
       * Horizontal scroll instead of wrapping (same fix as `ConversationTabs.tsx`'s
       * own `overflow-x-auto`/`flex-nowrap` pair for the identical class of
       * problem): at 100% zoom with 4+ steps, `flex-wrap` used to drop the
       * last step onto its own line with a dangling connector in front of it.
       * A single non-wrapping row that scrolls has no second line, so a
       * dangling connector is structurally impossible - simpler than a
       * wrap-aware "only draw a connector within the same line" layout, and
       * `overflow-x-auto` also guarantees the row can never grow the modal's
       * own width (it stays `sm:max-w-2xl`), same as the tab strip.
       */}
      {/*
       * ⚠️ Connector width and step padding are deliberately tight. This row
       * lives inside a modal whose width is fixed at `sm:max-w-2xl` (~640px of
       * content) REGARDLESS of viewport, so the `sm:` breakpoints elsewhere in
       * this component do not describe the space actually available here.
       * Measured: at the previous `sm:w-8` connectors and `sm:px-2` steps, the
       * 4-step ドメインを取得する template needed 649px in a 534px row and the
       * last step's label was permanently clipped. Trimming these plus making
       * the collapse control icon-only (`AssistantModal.tsx`) brings it under.
       */}
      <ol className="flex flex-nowrap items-center gap-1 overflow-x-auto">
        {template.steps.map((step, index) => {
          // Derived per-step (never `index < activeIndex`): a step can be
          // complete out of the visual order via a manual override, and the
          // done/current visuals must still reflect that faithfully.
          const isDone = isStepComplete(template, state, step.id)
          const isCurrent = index === activeIndex

          return (
            <li key={step.id} ref={isCurrent ? currentStepRef : undefined} className="flex shrink-0 items-center gap-1">
              {index > 0 ? (
                <span aria-hidden="true" className={cn('h-px w-3 sm:w-5', isDone || isCurrent ? 'bg-primary' : 'bg-border')} />
              ) : null}
              <span
                aria-current={isCurrent ? 'step' : undefined}
                title={step.label}
                className={cn(
                  'flex min-w-0 items-center gap-1 rounded-none px-1 py-1 text-sm',
                  isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-none text-xs font-semibold',
                    isCurrent && 'bg-primary text-primary-foreground',
                    isDone && 'bg-primary/15 text-primary',
                    !isCurrent && !isDone && 'border border-border text-muted-foreground',
                  )}
                >
                  {isDone ? <CheckIcon className="size-3.5" /> : index + 1}
                </span>
                {/*
                 * ⚠️ The `sm:` breakpoint that used to gate this label was a
                 * VIEWPORT query deciding a CONTAINER problem: this row lives
                 * in a modal fixed at `sm:max-w-2xl` (~640px of content) no
                 * matter how wide the screen is, so on any desktop the escape
                 * fired and every label rendered into a box that could not hold
                 * them. Measured: the 4-step ドメインを取得する template needed
                 * 649px in a 534px row, so its last label sat permanently
                 * behind the collapse button - the reported bug.
                 *
                 * Labels are kept (they are the point of the bar), and the fix
                 * is width plus reachability: the icon-only collapse button and
                 * the tightened spacing above bring a 4-step template inside the
                 * row, and `useCurrentStepInView` below scrolls the current step
                 * into view for longer templates that still cannot fit (the
                 * 5-step Webサイトを公開する one needs 888px, which no modal width
                 * in the design system would satisfy).
                 */}
                <span className="truncate text-[13px] sm:text-sm">{step.label}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Keeps the current step visible in the horizontally-scrolling row.
 *
 * A template whose labels exceed the modal's fixed ~640px (the 5-step
 * Webサイトを公開する one needs 888px) has to scroll, and without this the user
 * would have to discover that scrollbar to find out where they are - the same
 * "content is there but unreachable" complaint the width fix addresses for
 * shorter templates. `block: 'nearest'`/`inline: 'nearest'` keep the scroll to
 * the minimum needed and stop it from dragging any ancestor (notably the
 * message list) around. jsdom has no layout engine and therefore no real
 * `scrollIntoView`, so the call is guarded exactly as `MessageList` guards its
 * own.
 */
function useCurrentStepInView(activeIndex: number) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeIndex])
  return ref
}

function CompactWalkthroughStepper({
  template,
  state,
  onOpenAssistant,
}: {
  template: WalkthroughTemplate
  state: WalkthroughState
  onOpenAssistant?: () => void
}) {
  const totalCount = template.steps.length
  const completedCount = template.steps.filter((step) => isStepComplete(template, state, step.id)).length
  const ratio = progressRatio(template, state)
  const ariaLabel = walkthroughStepperAriaLabel(template.title)

  const content = (
    <>
      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground">{template.title}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {walkthroughCompactProgressLabel(completedCount, totalCount)}
      </span>
      <Progress value={ratio * 100} className="h-1.5 w-20 shrink-0 sm:w-28" />
    </>
  )

  if (onOpenAssistant) {
    return (
      <button
        type="button"
        onClick={onOpenAssistant}
        aria-label={ariaLabel}
        className="flex w-full items-center gap-2 rounded-none px-3 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {content}
      </button>
    )
  }

  return (
    <div aria-label={ariaLabel} className="flex items-center gap-2 px-1 py-1">
      {content}
    </div>
  )
}
