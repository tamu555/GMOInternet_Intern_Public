import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_GENERATED_CONTENT_NOTICE } from './assistantMessages'
import { ChatInput } from './ChatInput'

afterEach(cleanup)

function getTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText('AIアシスタントへのメッセージ') as HTMLTextAreaElement
}

describe('ChatInput', () => {
  it('calls onSubmit with the trimmed text and clears the field', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} busy={false} />)

    await user.type(getTextarea(), '  Vercelにつなぎたい  {Enter}')

    expect(onSubmit).toHaveBeenCalledWith('Vercelにつなぎたい')
    expect(getTextarea().value).toBe('')
  })

  it('does not submit a whitespace-only value', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} busy={false} />)

    await user.type(getTextarea(), '   {Enter}')

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('caps a 600-character paste at 500 characters', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSubmit={vi.fn()} busy={false} />)

    const textarea = getTextarea()
    await user.click(textarea)
    await user.paste('あ'.repeat(600))

    expect(textarea.value).toHaveLength(500)
  })

  it('updates the remaining-character counter as the user types', async () => {
    const user = userEvent.setup()
    render(<ChatInput onSubmit={vi.fn()} busy={false} />)

    expect(screen.getByText('残り500文字')).toBeInTheDocument()

    await user.type(getTextarea(), 'こんにちは')

    expect(screen.getByText('残り495文字')).toBeInTheDocument()
  })

  it('disables the send button but not the textarea while busy', () => {
    render(<ChatInput onSubmit={vi.fn()} busy={true} />)

    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled()
    expect(getTextarea()).toBeEnabled()
  })

  it('disables both the send button and the textarea when disabled', () => {
    render(<ChatInput onSubmit={vi.fn()} busy={false} disabled={true} />)

    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled()
    expect(getTextarea()).toBeDisabled()
  })

  it('shows the persistent "AI can be wrong" notice, and it is never an aria-live region', () => {
    render(<ChatInput onSubmit={vi.fn()} busy={false} />)

    const notice = screen.getByText(AI_GENERATED_CONTENT_NOTICE)
    expect(notice).toBeInTheDocument()
    // Static text - must not be re-announced repeatedly like the char counter.
    expect(notice).not.toHaveAttribute('aria-live')
  })

  it('inserts a newline instead of submitting on Shift+Enter', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} busy={false} />)

    const textarea = getTextarea()
    await user.type(textarea, '1行目{Shift>}{Enter}{/Shift}2行目')

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('1行目\n2行目')
  })
})

/**
 * Regression guard: the Enter that CONFIRMS a Japanese IME conversion was
 * being read as "send", so 「ドメインを購入したい」 was submitted the moment the
 * user accepted the kana-to-kanji conversion, and the confirmed text stayed
 * behind in the box.
 */
describe('ChatInput IME composition', () => {
  it('does not submit on the Enter that confirms an IME conversion', async () => {
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} busy={false} />)
    const textarea = getTextarea()

    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, { target: { value: 'ドメインを購入したい' } })
    // The conversion-confirming Enter: browsers report it as composing.
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('ドメインを購入したい')
  })

  it('submits on the Enter pressed after the composition has ended', async () => {
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} busy={false} />)
    const textarea = getTextarea()

    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, { target: { value: 'ドメインを購入したい' } })
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
    fireEvent.compositionEnd(textarea)
    // compositionend clears the guard on the next tick (Safari ordering).
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('ドメインを購入したい')
    expect(textarea).toHaveValue('')
  })
})
