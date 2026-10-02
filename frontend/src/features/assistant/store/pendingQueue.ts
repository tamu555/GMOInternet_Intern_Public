/**
 * Pending-message queue (spec browser-ai.md §6.4.1, FR-11). Pure functions
 * over a `ChatSessionStore` snapshot - no storage access, no side effects.
 * `store/modelStore.ts` uses this to know what to send to the engine the
 * moment the model reaches READY.
 */
import type { ChatMessage, ChatSessionStore } from '../types'

export interface PendingItem {
  conversationId: string
  message: ChatMessage
}

/** Every `status === 'pending'` message across all conversations, ordered by `createdAt` ascending. */
export function listPendingMessages(store: ChatSessionStore): PendingItem[] {
  const items: PendingItem[] = []
  for (const conversation of store.conversations) {
    for (const message of conversation.messages) {
      if (message.status === 'pending') items.push({ conversationId: conversation.id, message })
    }
  }
  return items.sort((a, b) => a.message.createdAt - b.message.createdAt)
}

export function nextPendingMessage(store: ChatSessionStore): PendingItem | null {
  return listPendingMessages(store)[0] ?? null
}

export function hasPendingMessages(store: ChatSessionStore): boolean {
  return store.conversations.some((conversation) => conversation.messages.some((message) => message.status === 'pending'))
}
