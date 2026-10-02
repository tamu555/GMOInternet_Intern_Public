import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatSessionStore, Conversation } from '../types'
import { hasPendingMessages, listPendingMessages, nextPendingMessage } from './pendingQueue'

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'createdAt' | 'status'>): ChatMessage {
  return { role: 'user', content: `msg-${overrides.id}`, ...overrides }
}

function conversation(id: string, messages: ChatMessage[]): Conversation {
  return { id, title: id, createdAt: 0, updatedAt: 0, messages }
}

function store(conversations: Conversation[]): ChatSessionStore {
  return { schemaVersion: 1, activeConversationId: conversations[0]?.id ?? '', conversations }
}

describe('pendingQueue', () => {
  it('returns an empty list/null/false when there is nothing pending', () => {
    const empty = store([conversation('c1', [message({ id: 'm1', createdAt: 1, status: 'done' })])])
    expect(listPendingMessages(empty)).toEqual([])
    expect(nextPendingMessage(empty)).toBeNull()
    expect(hasPendingMessages(empty)).toBe(false)
  })

  it('orders pending messages by createdAt across conversations, ignoring other statuses', () => {
    const c1 = conversation('c1', [
      message({ id: 'm-c1-late', createdAt: 30, status: 'pending' }),
      message({ id: 'm-c1-done', createdAt: 5, status: 'done' }),
    ])
    const c2 = conversation('c2', [
      message({ id: 'm-c2-early', createdAt: 10, status: 'pending' }),
      message({ id: 'm-c2-streaming', createdAt: 20, status: 'streaming' }),
      message({ id: 'm-c2-failed', createdAt: 1, status: 'failed' }),
    ])
    const snapshot = store([c1, c2])

    const pending = listPendingMessages(snapshot)
    expect(pending.map((item) => item.message.id)).toEqual(['m-c2-early', 'm-c1-late'])
    expect(pending[0]?.conversationId).toBe('c2')
    expect(pending[1]?.conversationId).toBe('c1')

    expect(nextPendingMessage(snapshot)?.message.id).toBe('m-c2-early')
    expect(hasPendingMessages(snapshot)).toBe(true)
  })
})
