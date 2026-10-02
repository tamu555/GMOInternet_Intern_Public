/**
 * Guided Walkthrough in-message card (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §4.2, spec browser-ai.md §34). Renders the CURRENT step only - title,
 * description, warnings, and whatever control advances it - never the whole
 * template at once (that is `WalkthroughStepper`'s job).
 *
 * FR-21 discipline: this component never decides progress itself. It only
 * calls back (`onCompleteStep`/`onRunStepAction`/`onDismiss`) - the actual
 * state transition happens in `store/chatStore.ts`, driven by an explicit
 * user action here or an app-observed route visit elsewhere
 * (`AssistantLauncher`). `completion.kind === 'manual'`'s checkbox is
 * intentionally honest (design note in `walkthroughMessages.ts`): the app has
 * no way to see work done on another company's own site, so the copy says so
 * rather than implying verification that never happened.
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DocSourceCard, SearchQueryCard } from './DocSourceCard'
import type { AssistantDocSource } from './docs/docSources'
import { findRoute } from './routing/routeManifest'
import type { WalkthroughState } from './types'
import { currentStep, isStepComplete, isWalkthroughComplete } from './walkthrough/walkthroughState'
import type { WalkthroughStep, WalkthroughStepAction, WalkthroughTemplate } from './walkthrough/walkthroughTemplates'
import {
  WALKTHROUGH_CARD_WARNINGS_LABEL,
  WALKTHROUGH_CLOSE_BUTTON_LABEL,
  WALKTHROUGH_COMPLETE_DESCRIPTION,
  WALKTHROUGH_COMPLETE_TITLE,
  WALKTHROUGH_DISMISS_BUTTON_LABEL,
  WALKTHROUGH_MANUAL_COMPLETION_LABEL,
  walkthroughStepActionLabel,
} from './walkthrough/walkthroughMessages'

/** A NAVIGATE action's destination screen name, or `null` for every other kind (and for a RouteId the Manifest does not carry). */
function routeTitleOf(action: WalkthroughStepAction): string | null {
  if (action.kind !== 'NAVIGATE' || !action.routeId) return null
  return findRoute(action.routeId)?.title ?? null
}

export interface WalkthroughCardProps {
  template: WalkthroughTemplate
  state: WalkthroughState
  /**
   * The §32 cards this step's `OPEN_DOC`/`RUN_WEB_SEARCH` action produced.
   * Resolved by `AssistantModal`'s `handleRunStepAction` (this component never
   * looks documentation up itself - it has no `PageContext` and no business
   * knowing the registry) and rendered here, immediately under the button that
   * produced them.
   *
   * ⚠️ They used to render in the modal's PINNED block, up beside the stepper,
   * on the stated rationale that they are walkthrough chrome rather than
   * conversation content. That rationale is defensible and the placement was
   * not: the button sits at the bottom of a scrolled message list, so clicking
   * it changed nothing the user could see and the result appeared off-screen
   * above. A control's result belongs next to the control.
   */
  docSources?: readonly AssistantDocSource[]
  searchQuery?: string | null
  onCompleteStep: (stepId: string) => void
  onRunStepAction: (step: WalkthroughStep) => void
  onDismiss: () => void
}

export function WalkthroughCard({
  template,
  state,
  docSources = [],
  searchQuery = null,
  onCompleteStep,
  onRunStepAction,
  onDismiss,
}: WalkthroughCardProps) {
  if (isWalkthroughComplete(template, state)) {
    return (
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 aria-hidden="true" className="size-5 text-primary" />
            <p className="font-heading text-sm font-semibold">{WALKTHROUGH_COMPLETE_TITLE}</p>
          </div>
          <p className="text-[13px] text-muted-foreground">{WALKTHROUGH_COMPLETE_DESCRIPTION}</p>
          <div className="flex justify-end">
            <Button onClick={onDismiss}>{WALKTHROUGH_CLOSE_BUTTON_LABEL}</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // `currentStep` only returns `null` once every step is complete, which the
  // branch above already handles - this is defensive only (keeps the
  // component total rather than assuming the two functions never disagree).
  const step = currentStep(template, state)
  if (!step) return null

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-heading text-sm font-semibold">{step.title}</p>
            <p className="text-[13px] text-muted-foreground">{step.description}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 whitespace-nowrap"
            onClick={onDismiss}
          >
            {WALKTHROUGH_DISMISS_BUTTON_LABEL}
          </Button>
        </div>

        {step.warnings && step.warnings.length > 0 ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>{WALKTHROUGH_CARD_WARNINGS_LABEL}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {step.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {step.completion.kind === 'manual' ? (
          <label className="flex cursor-pointer items-start gap-2 text-[13px] text-foreground/80">
            {/*
             * ⚠️ CONTROLLED, and keyed by step id. Both matter.
             *
             * This card renders the CURRENT step, so as progress advances the
             * same `<Checkbox>` position in the tree is reused for a different
             * step. With no `checked` prop the component kept its own internal
             * state, so after ticking one manual step the NEXT manual step's
             * card appeared with the box already ticked - and because the value
             * never changed, `onCheckedChange` never fired again and that step
             * could not be completed at all. That was the reported
             * 「3にチェックがついたまま出てくる」.
             *
             * `checked` is derived from real progress (always `false` for the
             * current step, which is by definition the first incomplete one),
             * and `key` forces a fresh instance per step so no internal state
             * can survive the transition even if the control is swapped later.
             */}
            <Checkbox
              key={step.id}
              className="mt-0.5"
              checked={isStepComplete(template, state, step.id)}
              onCheckedChange={(checked) => {
                if (checked === true) onCompleteStep(step.id)
              }}
            />
            {WALKTHROUGH_MANUAL_COMPLETION_LABEL}
          </label>
        ) : null}

        {step.action ? (
          <div className="flex justify-end">
            {/*
             * The label names the DESTINATION for a NAVIGATE step, so the title
             * lookup happens here where the RouteId is - `findRoute` is a static
             * Manifest lookup needing no `PageContext` (unlike
             * `resolveNavigation`, which the modal still does on the click).
             */}
            <Button onClick={() => onRunStepAction(step)}>
              {walkthroughStepActionLabel(step.action, routeTitleOf(step.action))}
            </Button>
          </div>
        ) : null}

        {/*
         * The result of the button above, in the same card. `AssistantModal`
         * clears both whenever the current step changes, so a card here always
         * belongs to the step it is shown under.
         */}
        {docSources.map((source) => (
          <DocSourceCard key={source.id} source={source} />
        ))}
        {searchQuery ? <SearchQueryCard query={searchQuery} /> : null}
      </CardContent>
    </Card>
  )
}
