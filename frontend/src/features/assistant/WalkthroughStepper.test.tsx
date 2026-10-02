import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalkthroughStepper } from './WalkthroughStepper'
import type { WalkthroughState } from './types'
import type { WalkthroughTemplate } from './walkthrough/walkthroughTemplates'

afterEach(cleanup)

/**
 * A small, self-contained fixture (same precedent as `walkthroughState.test.ts`'s
 * own `FIXTURE_TEMPLATE`) rather than a real `WALKTHROUGH_TEMPLATES` entry -
 * these tests must stay stable no matter how the real templates' copy or step
 * count later evolves.
 */
const TEMPLATE: WalkthroughTemplate = {
  id: 'ADD_A_RECORD',
  intent: 'ADD_A_RECORD',
  title: 'テストテンプレート',
  steps: [
    { id: 's1', label: 'ステップ1', title: 'ステップ1タイトル', description: '1つ目', completion: { kind: 'manual' } },
    {
      id: 's2',
      label: 'ステップ2',
      title: 'ステップ2タイトル',
      description: '2つ目',
      completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
    },
    { id: 's3', label: 'ステップ3', title: 'ステップ3タイトル', description: '3つ目', completion: { kind: 'manual' } },
  ],
}

function stateWith(completedStepIds: string[]): WalkthroughState {
  return { templateId: 'ADD_A_RECORD', completedStepIds, visitedRouteIds: [], startedAt: 0, dismissedAt: null }
}

describe('WalkthroughStepper full variant', () => {
  it('marks a completed step done (check mark) and the next incomplete step current', () => {
    const { container } = render(<WalkthroughStepper template={TEMPLATE} state={stateWith(['s1'])} />)

    const currentSpan = screen.getByText('ステップ2').closest('span[aria-current]')
    expect(currentSpan).toHaveAttribute('aria-current', 'step')

    // s1 (done) renders a check icon instead of its "1" digit.
    const items = container.querySelectorAll('li')
    expect(items[0]?.querySelector('svg')).not.toBeNull()
    // s3 (pending) still shows its plain step number, no check icon.
    expect(items[2]?.querySelector('svg')).toBeNull()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('derives done/current per step from the walkthrough state, never from a stored index', () => {
    // s2 completed via a manual override while s1 is still incomplete - an
    // out-of-order completion that a stored "current index" could not
    // represent correctly.
    const { container } = render(<WalkthroughStepper template={TEMPLATE} state={stateWith(['s2'])} />)

    const currentSpan = screen.getByText('ステップ1').closest('span[aria-current]')
    expect(currentSpan).toHaveAttribute('aria-current', 'step')

    const items = container.querySelectorAll('li')
    // s2 (index 1) is done despite being "ahead" of the current step (index 0).
    expect(items[1]?.querySelector('svg')).not.toBeNull()
  })
})

describe('WalkthroughStepper full variant layout (100% zoom / narrow-modal fix)', () => {
  /**
   * A 6-step template - more than the visible-at-once count that used to
   * trigger `flex-wrap`'s broken last-line-with-dangling-connector layout
   * (the bug report used 4 steps; 6 makes the regression margin generous).
   */
  const SIX_STEP_TEMPLATE: WalkthroughTemplate = {
    id: 'ADD_A_RECORD',
    intent: 'ADD_A_RECORD',
    title: '6ステップテンプレート',
    steps: Array.from({ length: 6 }, (_, i) => ({
      id: `s${i + 1}`,
      label: `ステップ${i + 1}`,
      title: `ステップ${i + 1}タイトル`,
      description: `${i + 1}つ目`,
      completion: { kind: 'manual' as const },
    })),
  }

  it('every step renders even with 6 steps', () => {
    render(<WalkthroughStepper template={SIX_STEP_TEMPLATE} state={stateWith([])} />)
    for (let i = 1; i <= 6; i += 1) {
      expect(screen.getByText(`ステップ${i}`)).toBeInTheDocument()
    }
  })

  it('the row scrolls horizontally instead of wrapping: the <ol> is a single non-wrapping, horizontally-scrollable flex row', () => {
    const { container } = render(<WalkthroughStepper template={SIX_STEP_TEMPLATE} state={stateWith([])} />)
    const list = container.querySelector('ol')
    expect(list).not.toBeNull()
    expect(list?.className).toMatch(/\bflex-nowrap\b/)
    expect(list?.className).toMatch(/\boverflow-x-auto\b/)
    // The old broken layout used `flex-wrap` - must never come back.
    expect(list?.className).not.toMatch(/\bflex-wrap\b/)
  })

  it('a dangling connector is structurally impossible: exactly steps.length - 1 connector spans exist, none before the first <li>', () => {
    const { container } = render(<WalkthroughStepper template={SIX_STEP_TEMPLATE} state={stateWith([])} />)
    const items = container.querySelectorAll('ol > li')
    expect(items).toHaveLength(6)
    // First item's first child is the label wrapper, not a connector - a
    // connector (`aria-hidden="true"`) is never the first thing it renders.
    expect(items[0]?.firstElementChild?.getAttribute('aria-hidden')).not.toBe('true')
    expect(items[0]?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1) // only the step circle, no connector
    // Every subsequent item DOES have a connector as its first child.
    for (let i = 1; i < items.length; i += 1) {
      const connectors = items[i]?.querySelectorAll('[aria-hidden="true"]') ?? []
      expect(connectors.length).toBe(2) // connector span + step circle
    }
  })

  it('aria-current="step" and the check-mark/number rendering still behave with 6 steps', () => {
    const { container } = render(<WalkthroughStepper template={SIX_STEP_TEMPLATE} state={stateWith(['s1', 's2', 's3'])} />)
    const currentSpan = screen.getByText('ステップ4').closest('span[aria-current]')
    expect(currentSpan).toHaveAttribute('aria-current', 'step')

    const items = container.querySelectorAll('ol > li')
    expect(items[0]?.querySelector('svg')).not.toBeNull() // s1 done
    expect(items[2]?.querySelector('svg')).not.toBeNull() // s3 done
    expect(items[5]?.querySelector('svg')).toBeNull() // s6 pending
  })
})

describe('WalkthroughStepper compact variant', () => {
  it('shows the template title and n/m progress, and calls onOpenAssistant when clicked', async () => {
    const onOpenAssistant = vi.fn()
    const user = userEvent.setup()
    render(<WalkthroughStepper template={TEMPLATE} state={stateWith(['s1'])} variant="compact" onOpenAssistant={onOpenAssistant} />)

    expect(screen.getByText('テストテンプレート')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()

    await user.click(screen.getByRole('button'))
    expect(onOpenAssistant).toHaveBeenCalledTimes(1)
  })

  it('renders as a non-interactive summary when onOpenAssistant is omitted', () => {
    render(<WalkthroughStepper template={TEMPLATE} state={stateWith([])} variant="compact" />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('0/3')).toBeInTheDocument()
  })
})
