import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantError } from './AssistantError'

afterEach(cleanup)

describe('AssistantError', () => {
  it('renders the unsupported message with a link to /easy/goal', () => {
    render(
      <MemoryRouter>
        <AssistantError errorKind="unsupported" onRetry={vi.fn()} />
      </MemoryRouter>,
    )

    expect(
      screen.getByText('この端末ではAIアシスタントを利用できません。かんたんモードから同じ操作をご案内します。'),
    ).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'かんたんモードを開く' })
    expect(link).toHaveAttribute('href', '/easy/goal')
  })

  it('renders the insufficient_storage message with no retry button', () => {
    render(
      <MemoryRouter>
        <AssistantError errorKind="insufficient_storage" onRetry={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByText('端末の空き容量が不足しているためAIを準備できません。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '再試行' })).not.toBeInTheDocument()
  })

  it('renders the load_failed message with a retry button that calls onRetry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <MemoryRouter>
        <AssistantError errorKind="load_failed" onRetry={onRetry} />
      </MemoryRouter>,
    )

    expect(screen.getByText('AIの準備に失敗しました。通信環境を確認してもう一度お試しください。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '再試行' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the same load-failed message and retry button for timeout', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <MemoryRouter>
        <AssistantError errorKind="timeout" onRetry={onRetry} />
      </MemoryRouter>,
    )

    expect(screen.getByText('AIの準備に失敗しました。通信環境を確認してもう一度お試しください。')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '再試行' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
