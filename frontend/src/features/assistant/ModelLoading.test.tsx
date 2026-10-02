import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelLoading } from './ModelLoading'
import type { ModelState } from './store/modelStore'

afterEach(cleanup)

function makeState(overrides: Partial<ModelState>): ModelState {
  return { status: 'NOT_STARTED', progress: 0, progressText: '', errorKind: null, lockedByOtherTab: false, ...overrides }
}

describe('ModelLoading', () => {
  it('shows 72% for DOWNLOADING at progress 0.72', () => {
    render(<ModelLoading state={makeState({ status: 'DOWNLOADING', progress: 0.72 })} onConsent={vi.fn()} />)

    expect(screen.getByText('72%')).toBeInTheDocument()
  })

  it('shows the consent button for AWAITING_CONSENT and calls onConsent on click', async () => {
    const user = userEvent.setup()
    const onConsent = vi.fn()
    render(<ModelLoading state={makeState({ status: 'AWAITING_CONSENT' })} onConsent={onConsent} />)

    const button = screen.getByRole('button', { name: '保存して準備する' })
    expect(button).toBeInTheDocument()

    await user.click(button)
    expect(onConsent).toHaveBeenCalledTimes(1)
  })

  it('shows the other-tab message instead of the progress bar when lockedByOtherTab', () => {
    render(<ModelLoading state={makeState({ status: 'CHECKING', lockedByOtherTab: true })} onConsent={vi.fn()} />)

    expect(screen.getByText('別のタブで準備中です。')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('renders nothing for READY', () => {
    const { container } = render(<ModelLoading state={makeState({ status: 'READY', progress: 1 })} onConsent={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })
})
