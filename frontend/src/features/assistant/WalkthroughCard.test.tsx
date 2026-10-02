import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalkthroughCard } from './WalkthroughCard'
import type { WalkthroughState } from './types'
import { navigationCtaLabel } from './assistantMessages'
import { findRoute } from './routing/routeManifest'
import { WALKTHROUGH_CLOSE_BUTTON_LABEL, WALKTHROUGH_STEP_OPEN_DOC_LABEL } from './walkthrough/walkthroughMessages'
import { findWalkthroughTemplate } from './walkthrough/walkthroughTemplates'
import type { WalkthroughTemplate } from './walkthrough/walkthroughTemplates'

afterEach(cleanup)

/**
 * A small, self-contained fixture (same precedent as `walkthroughState.test.ts`'s
 * `FIXTURE_TEMPLATE`): one `manual` step with no action, one `visited-route`
 * step with a `NAVIGATE` action - covers both control shapes without coupling
 * these tests to any real template's copy.
 */
const FIXTURE_TEMPLATE: WalkthroughTemplate = {
  id: 'ADD_A_RECORD',
  intent: 'ADD_A_RECORD',
  title: 'テストテンプレート',
  steps: [
    {
      id: 'manual-step',
      label: '手動',
      title: '手動ステップのタイトル',
      description: '手動ステップの説明文',
      completion: { kind: 'manual' },
    },
    {
      id: 'action-step',
      label: 'アクション',
      title: 'アクションステップのタイトル',
      description: 'アクションステップの説明文',
      completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
      action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
    },
  ],
}

function fixtureState(completedStepIds: string[]): WalkthroughState {
  return { templateId: 'ADD_A_RECORD', completedStepIds, visitedRouteIds: [], startedAt: 0, dismissedAt: null }
}

describe('WalkthroughCard: current step', () => {
  it("renders the current step's title and description", () => {
    render(
      <WalkthroughCard
        template={FIXTURE_TEMPLATE}
        state={fixtureState([])}
        onCompleteStep={vi.fn()}
        onRunStepAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('手動ステップのタイトル')).toBeInTheDocument()
    expect(screen.getByText('手動ステップの説明文')).toBeInTheDocument()
  })

  it('a manual step shows the completion control and calls onCompleteStep when checked', async () => {
    const onCompleteStep = vi.fn()
    const user = userEvent.setup()
    render(
      <WalkthroughCard
        template={FIXTURE_TEMPLATE}
        state={fixtureState([])}
        onCompleteStep={onCompleteStep}
        onRunStepAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('checkbox'))
    expect(onCompleteStep).toHaveBeenCalledWith('manual-step')
  })

  it('a step with an action shows a button that calls onRunStepAction', async () => {
    const onRunStepAction = vi.fn()
    const user = userEvent.setup()
    // manual-step already done -> current step is action-step.
    render(
      <WalkthroughCard
        template={FIXTURE_TEMPLATE}
        state={fixtureState(['manual-step'])}
        onCompleteStep={vi.fn()}
        onRunStepAction={onRunStepAction}
        onDismiss={vi.fn()}
      />,
    )

    // ⚠️ The label names the DESTINATION, not the step - a step title is a verb
    // phrase, so the old `${step.title}へ進む` produced 「アクションステップの
    // タイトルへ進む」 (and, on OPEN_DOC steps, promised navigation that never
    // happens). Asserted against the Manifest's own screen title so this test
    // pins the behaviour rather than a copy of the string.
    const dnsRecordsTitle = findRoute('DNS_RECORDS')?.title
    if (!dnsRecordsTitle) throw new Error('DNS_RECORDS missing from the Route Manifest')
    await user.click(screen.getByRole('button', { name: navigationCtaLabel(dnsRecordsTitle) }))
    expect(onRunStepAction).toHaveBeenCalledWith(FIXTURE_TEMPLATE.steps[1])
  })

  it('an OPEN_DOC step does not promise navigation', async () => {
    // The reported label was 「サービス側で設定値を確認する**へ進む**」 on a step whose
    // action only surfaces documentation cards - it navigates nowhere.
    const docTemplate: WalkthroughTemplate = {
      ...FIXTURE_TEMPLATE,
      steps: [
        FIXTURE_TEMPLATE.steps[0]!,
        { ...FIXTURE_TEMPLATE.steps[1]!, completion: { kind: 'manual' }, action: { kind: 'OPEN_DOC', docTopic: 'custom-domain' } },
      ],
    }
    render(
      <WalkthroughCard
        template={docTemplate}
        state={fixtureState(['manual-step'])}
        onCompleteStep={vi.fn()}
        onRunStepAction={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: WALKTHROUGH_STEP_OPEN_DOC_LABEL })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /へ進む/ })).not.toBeInTheDocument()
  })
})

describe('WalkthroughCard: mandatory NS-change warning', () => {
  it('shows the CHANGE_NAMESERVER template warning, not collapsed', () => {
    const template = findWalkthroughTemplate('CHANGE_NAMESERVER')
    if (!template) throw new Error('CHANGE_NAMESERVER template not found')
    const firstStepWarning = template.steps[0]?.warnings?.[0]
    if (!firstStepWarning) throw new Error('CHANGE_NAMESERVER step 1 has no warning to assert')

    const state: WalkthroughState = { templateId: 'CHANGE_NAMESERVER', completedStepIds: [], visitedRouteIds: [], startedAt: 0, dismissedAt: null }
    render(
      <WalkthroughCard template={template} state={state} onCompleteStep={vi.fn()} onRunStepAction={vi.fn()} onDismiss={vi.fn()} />,
    )

    expect(screen.getByText(firstStepWarning)).toBeVisible()
  })
})

describe('WalkthroughCard: all steps complete', () => {
  it('renders the completion state and calls onDismiss when closed', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      <WalkthroughCard
        template={FIXTURE_TEMPLATE}
        state={fixtureState(['manual-step', 'action-step'])}
        onCompleteStep={vi.fn()}
        onRunStepAction={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    // Neither current-step control renders once everything is done.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: WALKTHROUGH_CLOSE_BUTTON_LABEL }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
