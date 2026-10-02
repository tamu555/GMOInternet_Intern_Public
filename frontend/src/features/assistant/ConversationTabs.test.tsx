import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DELETE_CONVERSATION_BUTTON_LABEL, NEW_CONVERSATION_DEFAULT_TITLE } from './assistantMessages'
import { ConversationTabs } from './ConversationTabs'
import type { Conversation } from './types'

afterEach(cleanup)

function makeConversation(id: string, title: string): Conversation {
  return { id, title, createdAt: 0, updatedAt: 0, messages: [] }
}

const CONVERSATIONS: Conversation[] = [makeConversation('conv-1', 'Web接続'), makeConversation('conv-2', 'メール設定')]

describe('ConversationTabs', () => {
  it('renders every conversation as a tab', () => {
    render(
      <ConversationTabs
        conversations={CONVERSATIONS}
        activeConversationId="conv-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Web接続' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'メール設定' })).toBeInTheDocument()
  })

  it('calls onSelect with the clicked conversation id', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <ConversationTabs
        conversations={CONVERSATIONS}
        activeConversationId="conv-1"
        onSelect={onSelect}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('tab', { name: 'メール設定' }))

    expect(onSelect).toHaveBeenCalledWith('conv-2')
  })

  it('calls onDelete for the clicked conversation without calling onSelect', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    render(
      <ConversationTabs
        conversations={CONVERSATIONS}
        activeConversationId="conv-1"
        onSelect={onSelect}
        onDelete={onDelete}
        onCreate={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'チャットを削除: メール設定' }))

    expect(onDelete).toHaveBeenCalledWith('conv-2')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('calls onCreate when the + button is clicked', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(
      <ConversationTabs
        conversations={CONVERSATIONS}
        activeConversationId="conv-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onCreate={onCreate}
      />,
    )

    await user.click(screen.getByRole('button', { name: '新規チャット' }))

    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})

describe('ConversationTabs: tab labels', () => {
  it('shows 「新しいタブ」 for a conversation that has no title yet', () => {
    render(
      <ConversationTabs
        conversations={[makeConversation('c1', '')]}
        activeConversationId="c1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByRole('tab', { name: NEW_CONVERSATION_DEFAULT_TITLE })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: `${DELETE_CONVERSATION_BUTTON_LABEL}: ${NEW_CONVERSATION_DEFAULT_TITLE}` }),
    ).toBeInTheDocument()
  })

  it('gives a long title its own truncating box instead of letting it overflow the trigger', () => {
    const longTitle = 'VerselのDNSレコードをドメイ…'
    render(
      <ConversationTabs
        conversations={[makeConversation('c1', longTitle)]}
        activeConversationId="c1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    const tab = screen.getByRole('tab', { name: longTitle })
    // The full text stays reachable even though the box is clipped.
    expect(tab).toHaveAttribute('title', longTitle)
    // `truncate` must sit on a block-level label inside the flex trigger, not
    // on the trigger itself, or text-overflow never applies.
    const label = tab.querySelector('span')
    expect(label).not.toBeNull()
    expect(label!.className).toContain('truncate')
    expect(tab.className).toContain('min-w-0')
  })
})

/**
 * Regression guard for a browser report with 5+ tabs: the tab row and the
 * modal header buttons rendered outside the modal panel because this div
 * grew instead of scrolling. `DialogContent` (components/ui/dialog.tsx) is
 * `display: grid`, so `overflow-x-auto` alone cannot stop this div growing -
 * jsdom has no layout engine, so it cannot reproduce the actual overflow, but
 * it CAN assert the two classes the fix depends on are both present (see the
 * comment on this div in ConversationTabs.tsx for the full mechanism).
 */
describe('ConversationTabs: scroll container never grows the modal', () => {
  it('carries both overflow-x-auto and min-w-0 on the tab strip scroll container', () => {
    render(
      <ConversationTabs
        conversations={CONVERSATIONS}
        activeConversationId="conv-1"
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    // `TabsList` (role="tablist") is the scroll container's own direct
    // child - there is only one tablist in this component.
    const scrollContainer = screen.getByRole('tablist').parentElement
    expect(scrollContainer).not.toBeNull()
    expect(scrollContainer!.className).toContain('overflow-x-auto')
    // Without min-w-0, this flex/grid item's default `min-width: auto`
    // refuses to shrink below the tab strip's full intrinsic width, so
    // `overflow-x-auto` never actually gets a chance to scroll.
    expect(scrollContainer!.className).toContain('min-w-0')
  })
})
