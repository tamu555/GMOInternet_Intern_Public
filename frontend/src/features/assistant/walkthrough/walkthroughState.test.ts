import { describe, expect, it } from 'vitest'
import type { WalkthroughState } from '../types'
import {
  completeStep,
  createWalkthroughState,
  currentStep,
  currentStepIndex,
  dismissWalkthrough,
  isStepComplete,
  isWalkthroughComplete,
  progressRatio,
  recordRouteVisit,
} from './walkthroughState'
import type { WalkthroughTemplate } from './walkthroughTemplates'

/**
 * A small, self-contained fixture rather than a real `WALKTHROUGH_TEMPLATES`
 * entry - this module's tests must stay stable no matter how the real
 * templates' copy or step count later evolves.
 */
const FIXTURE_TEMPLATE: WalkthroughTemplate = {
  id: 'ADD_A_RECORD',
  intent: 'ADD_A_RECORD',
  title: 'テンプレート',
  steps: [
    { id: 's1-manual', label: '1', title: '1', description: '1', completion: { kind: 'manual' } },
    { id: 's2-route', label: '2', title: '2', description: '2', completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' } },
    { id: 's3-manual', label: '3', title: '3', description: '3', completion: { kind: 'manual' } },
  ],
}

describe('createWalkthroughState', () => {
  it('starts with nothing done and dismissedAt null', () => {
    const state = createWalkthroughState('ADD_A_RECORD', 1000)
    expect(state).toEqual({
      templateId: 'ADD_A_RECORD',
      completedStepIds: [],
      visitedRouteIds: [],
      startedAt: 1000,
      dismissedAt: null,
    })
  })
})

describe('currentStepIndex derivation', () => {
  it('is 0 when nothing is done', () => {
    const state = createWalkthroughState('ADD_A_RECORD', 0)
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(0)
    expect(currentStep(FIXTURE_TEMPLATE, state)?.id).toBe('s1-manual')
  })

  it('advances past a step once it is complete', () => {
    const state = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(1)
    expect(currentStep(FIXTURE_TEMPLATE, state)?.id).toBe('s2-route')
  })

  it('equals steps.length once every step is done', () => {
    let state = createWalkthroughState('ADD_A_RECORD', 0)
    state = completeStep(state, 's1-manual')
    state = completeStep(state, 's2-route')
    state = completeStep(state, 's3-manual')
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(3)
    expect(currentStep(FIXTURE_TEMPLATE, state)).toBeNull()
  })
})

describe('visited-route completion', () => {
  it('ignores a route visit that arrives before its step is the current one', () => {
    // ⚠️ Reported bug, now the contract. `DOMAIN_SEARCH` is the app's own top
    // page (`/`), so starting a walkthrough there recorded that visit
    // immediately - and ticking 「名前を決める」 then ticked 「空きを確認する」 along
    // with it. One click, two steps done, for work the user had not done.
    const state = recordRouteVisit(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0), 'DNS_RECORDS')
    expect(state.visitedRouteIds).toEqual([])
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's2-route')).toBe(false)
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(0)
  })

  it('completing the step before it does NOT also complete the visited-route step', () => {
    // The other half of the same report: one tick must advance exactly one step.
    let state = recordRouteVisit(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0), 'DNS_RECORDS')
    state = completeStep(state, 's1-manual')
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's1-manual')).toBe(true)
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's2-route')).toBe(false)
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(1)
  })

  it('completes a visited-route step from a visit made while that step is current', () => {
    let state = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    state = recordRouteVisit(FIXTURE_TEMPLATE, state, 'DNS_RECORDS')
    expect(state.visitedRouteIds).toEqual(['DNS_RECORDS'])
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's2-route')).toBe(true)
    expect(currentStepIndex(FIXTURE_TEMPLATE, state)).toBe(2)
  })

  it('a manual tick out of order never unlocks a later step\'s route evidence', () => {
    // Ticking step 3 early is honoured (explicit user action), but step 2 still
    // needs step 1 closed before its recorded visit counts.
    let state = recordRouteVisit(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0), 'DNS_RECORDS')
    state = completeStep(state, 's3-manual')
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's3-manual')).toBe(true)
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's2-route')).toBe(false)
    expect(isWalkthroughComplete(FIXTURE_TEMPLATE, state)).toBe(false)
  })

  it('progressRatio counts only genuinely reached steps, not deferred route evidence', () => {
    const state = recordRouteVisit(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0), 'DNS_RECORDS')
    expect(progressRatio(FIXTURE_TEMPLATE, state)).toBe(0)
  })

  it('also completes a visited-route step via a manual completeStep override', () => {
    const state = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's2-route')
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's2-route')).toBe(true)
    expect(state.visitedRouteIds).toEqual([])
  })

  it('a manual step is never completed by recordRouteVisit, whatever the route', () => {
    const state = recordRouteVisit(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0), 'DNS_RECORDS')
    expect(isStepComplete(FIXTURE_TEMPLATE, state, 's1-manual')).toBe(false)
  })

  it('recordRouteVisit returns the SAME reference for an already-recorded route (stable-snapshot contract)', () => {
    const started = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    const first = recordRouteVisit(FIXTURE_TEMPLATE, started, 'DNS_RECORDS')
    const second = recordRouteVisit(FIXTURE_TEMPLATE, first, 'DNS_RECORDS')
    expect(second).toBe(first)
  })

  it('recordRouteVisit de-duplicates instead of appending a second entry', () => {
    let state = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    state = recordRouteVisit(FIXTURE_TEMPLATE, state, 'DNS_RECORDS')
    state = recordRouteVisit(FIXTURE_TEMPLATE, state, 'DNS_RECORDS')
    expect(state.visitedRouteIds).toEqual(['DNS_RECORDS'])
  })
})

describe('immutability', () => {
  it('completeStep does not mutate its input', () => {
    const input = createWalkthroughState('ADD_A_RECORD', 0)
    const snapshot: WalkthroughState = JSON.parse(JSON.stringify(input))
    completeStep(input, 's1-manual')
    expect(input).toEqual(snapshot)
  })

  it('recordRouteVisit does not mutate its input', () => {
    const input = createWalkthroughState('ADD_A_RECORD', 0)
    const snapshot: WalkthroughState = JSON.parse(JSON.stringify(input))
    recordRouteVisit(FIXTURE_TEMPLATE, input, 'DNS_RECORDS')
    expect(input).toEqual(snapshot)
  })

  it('dismissWalkthrough does not mutate its input', () => {
    const input = createWalkthroughState('ADD_A_RECORD', 0)
    const snapshot: WalkthroughState = JSON.parse(JSON.stringify(input))
    dismissWalkthrough(input, 500)
    expect(input).toEqual(snapshot)
  })
})

describe('progressRatio', () => {
  it('is 0 when nothing is done', () => {
    expect(progressRatio(FIXTURE_TEMPLATE, createWalkthroughState('ADD_A_RECORD', 0))).toBe(0)
  })

  it('is a fraction mid-way through', () => {
    const state = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    expect(progressRatio(FIXTURE_TEMPLATE, state)).toBeCloseTo(1 / 3)
  })

  it('is 1 once every step is done', () => {
    let state = createWalkthroughState('ADD_A_RECORD', 0)
    state = completeStep(state, 's1-manual')
    state = completeStep(state, 's2-route')
    state = completeStep(state, 's3-manual')
    expect(progressRatio(FIXTURE_TEMPLATE, state)).toBe(1)
  })
})

describe('isWalkthroughComplete', () => {
  it('is false until every step is complete, true once all are', () => {
    let state = createWalkthroughState('ADD_A_RECORD', 0)
    expect(isWalkthroughComplete(FIXTURE_TEMPLATE, state)).toBe(false)
    state = completeStep(state, 's1-manual')
    state = recordRouteVisit(FIXTURE_TEMPLATE, state, 'DNS_RECORDS')
    expect(isWalkthroughComplete(FIXTURE_TEMPLATE, state)).toBe(false)
    state = completeStep(state, 's3-manual')
    expect(isWalkthroughComplete(FIXTURE_TEMPLATE, state)).toBe(true)
  })
})

describe('dismissWalkthrough', () => {
  it('sets dismissedAt and changes nothing else', () => {
    const before = completeStep(createWalkthroughState('ADD_A_RECORD', 0), 's1-manual')
    const after = dismissWalkthrough(before, 999)
    expect(after).toEqual({ ...before, dismissedAt: 999 })
    expect(before.dismissedAt).toBeNull()
  })
})
