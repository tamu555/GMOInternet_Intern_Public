/**
 * Pure Guided Walkthrough progress reducer (plan §2/§6, spec browser-ai.md
 * §34, FR-21). No React, no I/O, no `Date.now()` - every "now" comes from the
 * caller, exactly like `chatStore.ts`'s own `commit()` pattern one layer up.
 *
 * FR-21 (the load-bearing invariant this whole module exists to protect):
 * progress can only ever advance from an app-observed route visit
 * (`recordRouteVisit`, fed by `AssistantLauncher`'s `useLocation()`) or an
 * explicit user action (`completeStep`, a checkbox click). Nothing exported
 * here takes model output as an argument, and nothing here ever will -
 * that is the whole point of keeping this module intent-agnostic and
 * `WalkthroughStep`-shaped only.
 */
import type { RouteId } from '../routing/routeManifest'
import type { WalkthroughState } from '../types'
import type { WalkthroughId, WalkthroughStep, WalkthroughTemplate } from './walkthroughTemplates'

export function createWalkthroughState(templateId: WalkthroughId, now: number): WalkthroughState {
  return { templateId, completedStepIds: [], visitedRouteIds: [], startedAt: now, dismissedAt: null }
}

/**
 * Completeness of every step, computed in template order in one pass.
 *
 * ⚠️ Route-visit evidence is gated on all EARLIER steps already being complete.
 * Without that gate, a recorded visit ticks its step the moment the route is
 * seen, no matter where the user actually is in the walkthrough - and the
 * reported bug follows immediately: `DOMAIN_SEARCH` resolves to `/`, the app's
 * own top page, so simply opening the assistant from the top page recorded that
 * visit and put a ✓ on 「空きを確認する」 while 「名前を決める」 was still the current
 * step. Every `visited-route` step has the same failure mode (e.g.
 * 「取得を確認する」 ticks itself if the user ever happened to open /mypage first),
 * which is why this is fixed once here rather than per step.
 *
 * A MANUAL tick is deliberately NOT gated: it is an explicit user action
 * ("I have done this"), and the module has always honoured those out of order.
 * It just does not unlock route evidence for later steps - `allPreviousComplete`
 * tracks real completeness, so ticking step 3 early cannot make step 4's
 * recorded visit count while steps 1-2 are still open.
 *
 * No dead end: the gate only defers evidence, never discards it.
 * `visitedRouteIds` keeps the visit, so the moment the earlier steps close, a
 * step whose route was already visited turns ✓ without the user having to
 * navigate there again - which matters precisely because they are usually
 * already standing on that page.
 */
function completionFlags(template: WalkthroughTemplate, state: WalkthroughState): boolean[] {
  const flags: boolean[] = []
  // Annotated: `complete` reads `allPreviousComplete` and `allPreviousComplete`
  // is then updated from `complete`, which TS cannot infer through (TS7022).
  let allPreviousComplete: boolean = true
  for (const step of template.steps) {
    const complete: boolean =
      state.completedStepIds.includes(step.id) ||
      (step.completion.kind === 'visited-route' &&
        allPreviousComplete &&
        state.visitedRouteIds.includes(step.completion.routeId))
    flags.push(complete)
    allPreviousComplete = allPreviousComplete && complete
  }
  return flags
}

/**
 * A `visited-route` step is complete when the app recorded that route visit
 * AND every earlier step is already complete (see `completionFlags`), OR when
 * its id was explicitly completed manually (an override - e.g. the user
 * already knows they finished it and ticks the box instead of navigating). A
 * `manual` step is complete only via the explicit override, since the app has
 * no other way to observe it.
 */
export function isStepComplete(template: WalkthroughTemplate, state: WalkthroughState, stepId: string): boolean {
  const index = template.steps.findIndex((candidate) => candidate.id === stepId)
  if (index === -1) return false
  return completionFlags(template, state)[index] ?? false
}

/**
 * Derived, never stored (plan §2): the index of the first incomplete step, or
 * `template.steps.length` once every step is done. Storing this separately
 * would let it drift out of sync with `completedStepIds`/`visitedRouteIds`.
 */
export function currentStepIndex(template: WalkthroughTemplate, state: WalkthroughState): number {
  const index = completionFlags(template, state).findIndex((complete) => !complete)
  return index === -1 ? template.steps.length : index
}

export function currentStep(template: WalkthroughTemplate, state: WalkthroughState): WalkthroughStep | null {
  return template.steps[currentStepIndex(template, state)] ?? null
}

/** Explicit user action (FR-21): ticking a step's checkbox, whatever its `completion.kind`. */
export function completeStep(state: WalkthroughState, stepId: string): WalkthroughState {
  if (state.completedStepIds.includes(stepId)) return state
  return { ...state, completedStepIds: [...state.completedStepIds, stepId] }
}

/**
 * App-observed route visit (FR-21), called from `AssistantLauncher` on every
 * navigation - including while the walkthrough UI is closed. De-duplicates
 * and, critically, returns the exact same `state` reference (not a new object
 * with equal contents) when `routeId` was already recorded: this is called on
 * every single route change regardless of whether a walkthrough is even
 * active, so a would-be no-op MUST NOT produce a new reference - the chat
 * store's `commit()` treats "state changed" as "persist + notify
 * subscribers", and re-notifying on every navigation would defeat
 * `useSyncExternalStore`'s stable-snapshot contract for no reason.
 */
export function recordRouteVisit(
  template: WalkthroughTemplate,
  state: WalkthroughState,
  routeId: RouteId,
): WalkthroughState {
  if (state.visitedRouteIds.includes(routeId)) return state
  // ⚠️ Only a visit that is evidence for the step the user is ON counts.
  //
  // Recording every visit meant a route seen BEFORE its step was reached
  // completed that step the instant the preceding steps closed. Concretely:
  // `DOMAIN_SEARCH` is the app's own top page (`/`), so starting a walkthrough
  // there recorded that visit immediately, and ticking 「名前を決める」 then
  // ticked 「空きを確認する」 along with it - one click, two steps done, for work
  // the user had not done. Requiring the visit to arrive while the step is
  // current makes "I went there to do this" the evidence, instead of "I once
  // happened to be there".
  //
  // The step's own NAVIGATE button records explicitly (`AssistantModal`'s
  // `handleRunStepAction`), which is what keeps this from dead-ending when the
  // user is already standing on the right page and no navigation event fires.
  const step = currentStep(template, state)
  if (!step || step.completion.kind !== 'visited-route' || step.completion.routeId !== routeId) return state
  return { ...state, visitedRouteIds: [...state.visitedRouteIds, routeId] }
}

export function isWalkthroughComplete(template: WalkthroughTemplate, state: WalkthroughState): boolean {
  return completionFlags(template, state).every(Boolean)
}

/** "やめる" (plan §5): only sets `dismissedAt` - everything else about the state is preserved so it can resume later. */
export function dismissWalkthrough(state: WalkthroughState, now: number): WalkthroughState {
  return { ...state, dismissedAt: now }
}

/** 0-1. A template with no steps (never happens in practice - see the ≥3-step test) reports 0 rather than dividing by zero. */
export function progressRatio(template: WalkthroughTemplate, state: WalkthroughState): number {
  if (template.steps.length === 0) return 0
  const completedCount = completionFlags(template, state).filter(Boolean).length
  return completedCount / template.steps.length
}
