import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantAction } from '../actions'
import { ASSISTANT_CHAT_STORAGE_KEY } from '../config/assistantConfig'
import {
  appendMessage,
  clearAssistantChat,
  completeWalkthroughStep,
  conversationTitleFromInput,
  createConversation,
  deleteAllConversations,
  deleteConversation,
  dismissActiveWalkthrough,
  ensureActiveConversation,
  getChatSnapshot,
  mergeConversationGoal,
  recordWalkthroughRouteVisit,
  resetChatStoreForTest,
  selectConversation,
  startWalkthrough,
  subscribeChatStore,
  updateMessage,
} from './chatStore'

beforeEach(() => {
  window.sessionStorage.clear()
  resetChatStoreForTest()
})

describe('conversations (FR-06/07/08)', () => {
  it('creates, selects, and deletes conversations', () => {
    const a = createConversation('A')
    const b = createConversation('B')
    expect(getChatSnapshot().conversations).toHaveLength(2)
    expect(getChatSnapshot().activeConversationId).toBe(b.id)

    selectConversation(a.id)
    expect(getChatSnapshot().activeConversationId).toBe(a.id)

    deleteConversation(a.id)
    expect(getChatSnapshot().conversations.map((c) => c.id)).toEqual([b.id])
    // `a` was the active conversation, so deleting it falls back to `b`.
    expect(getChatSnapshot().activeConversationId).toBe(b.id)
  })

  it('at least 2 conversations coexist and can be freely switched (FR-08)', () => {
    const a = createConversation('A')
    const b = createConversation('B')
    const c = createConversation('C')
    expect(getChatSnapshot().conversations).toHaveLength(3)

    selectConversation(a.id)
    expect(getChatSnapshot().activeConversationId).toBe(a.id)
    selectConversation(c.id)
    expect(getChatSnapshot().activeConversationId).toBe(c.id)
    selectConversation(b.id)
    expect(getChatSnapshot().activeConversationId).toBe(b.id)
  })

  it('falls back the active id to another conversation when the active one is deleted', () => {
    const a = createConversation('A')
    const b = createConversation('B')
    selectConversation(a.id)
    deleteConversation(a.id)
    expect(getChatSnapshot().activeConversationId).toBe(b.id)
  })

  it('clears the active id to empty when the last conversation is deleted', () => {
    const a = createConversation('A')
    deleteConversation(a.id)
    expect(getChatSnapshot().conversations).toHaveLength(0)
    expect(getChatSnapshot().activeConversationId).toBe('')
  })

  it('deleteAllConversations empties the store', () => {
    createConversation('A')
    createConversation('B')
    deleteAllConversations()
    expect(getChatSnapshot().conversations).toHaveLength(0)
    expect(getChatSnapshot().activeConversationId).toBe('')
  })

  it('ensureActiveConversation creates one when none exists, and reuses it afterwards', () => {
    expect(getChatSnapshot().conversations).toHaveLength(0)
    const created = ensureActiveConversation()
    expect(getChatSnapshot().conversations).toHaveLength(1)
    expect(ensureActiveConversation().id).toBe(created.id)
  })

  it('appendMessage/updateMessage mutate the targeted conversation only', () => {
    const conversation = createConversation('A')
    const message = appendMessage(conversation.id, { role: 'user', content: 'hello', status: 'done' })
    expect(getChatSnapshot().conversations[0]?.messages).toEqual([message])

    updateMessage(conversation.id, message.id, { status: 'failed' })
    expect(getChatSnapshot().conversations[0]?.messages[0]?.status).toBe('failed')
  })
})

describe('clearAssistantChat (§7.3, FR-14)', () => {
  it('removes the sessionStorage key and resets memory', () => {
    createConversation('A')
    expect(window.sessionStorage.getItem(ASSISTANT_CHAT_STORAGE_KEY)).not.toBeNull()

    clearAssistantChat()

    expect(window.sessionStorage.getItem(ASSISTANT_CHAT_STORAGE_KEY)).toBeNull()
    expect(getChatSnapshot().conversations).toHaveLength(0)
    expect(getChatSnapshot().activeConversationId).toBe('')
  })
})

describe('corrupt storage (§7.6)', () => {
  it('discards a schemaVersion mismatch and starts empty', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 99, activeConversationId: '', conversations: [] }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot()).toEqual({ schemaVersion: 1, activeConversationId: '', conversations: [] })
  })

  it('discards unparseable JSON and starts empty', () => {
    window.sessionStorage.setItem(ASSISTANT_CHAT_STORAGE_KEY, '{not json')
    resetChatStoreForTest()
    expect(getChatSnapshot()).toEqual({ schemaVersion: 1, activeConversationId: '', conversations: [] })
  })
})

describe('conversationTitleFromInput (§7.5)', () => {
  it('keeps the first 20 characters and marks the cut with an ellipsis', () => {
    const input = 'a'.repeat(30)
    expect(conversationTitleFromInput(input)).toBe(`${'a'.repeat(20)}…`)
  })

  it('leaves an input of 20 characters or fewer untouched, with no ellipsis', () => {
    expect(conversationTitleFromInput('a'.repeat(20))).toBe('a'.repeat(20))
    expect(conversationTitleFromInput('ドメインを取得したい')).toBe('ドメインを取得したい')
  })

  it('does not split a surrogate-pair emoji in half', () => {
    const emoji = '\u{1F600}' // U+1F600 GRINNING FACE - a surrogate pair in UTF-16.
    const input = emoji.repeat(25)
    const title = conversationTitleFromInput(input)
    // 20 kept characters + the ellipsis marker.
    expect(Array.from(title)).toHaveLength(21)
    expect(title).toBe(`${emoji.repeat(20)}…`)
  })
})

describe('stable snapshot (useSyncExternalStore requirement)', () => {
  it('returns the same reference across a no-op read', () => {
    createConversation('A')
    const first = getChatSnapshot()
    const second = getChatSnapshot()
    expect(first).toBe(second)
  })

  it('returns a new reference only after a mutation', () => {
    const first = getChatSnapshot()
    createConversation('A')
    const second = getChatSnapshot()
    expect(second).not.toBe(first)
  })
})

describe('subscribers', () => {
  it('fires exactly once per mutation', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeChatStore(listener)

    createConversation('A')
    expect(listener).toHaveBeenCalledTimes(1)

    createConversation('B')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    createConversation('C')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('persistence across a simulated reload', () => {
  it('survives write -> resetChatStoreForTest() -> read back', () => {
    const conversation = createConversation('A')
    appendMessage(conversation.id, { role: 'user', content: 'hi', status: 'done' })

    resetChatStoreForTest()

    const reloaded = getChatSnapshot()
    expect(reloaded.conversations).toHaveLength(1)
    expect(reloaded.conversations[0]?.title).toBe('A')
    expect(reloaded.conversations[0]?.messages).toHaveLength(1)
  })
})

describe('sessionStorage failure (§7.4 ⚠️ private mode)', () => {
  it('degrades to memory-only without throwing', () => {
    const setItemSpy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => createConversation('A')).not.toThrow()
    expect(getChatSnapshot().conversations).toHaveLength(1)

    setItemSpy.mockRestore()
  })
})

describe('mergeConversationGoal (v1.4 §29.2/design contract §2.1)', () => {
  it('sets intent and slots on the first merge', () => {
    const conversation = createConversation('A')
    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: {} })

    const goal = getChatSnapshot().conversations[0]?.goal
    expect(goal?.intent).toBe('CONNECT_WEBSITE')
    expect(goal?.slots).toEqual({})
  })

  it('merges slots key-by-key, with the new turn winning a conflict', () => {
    const conversation = createConversation('A')
    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' } })
    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: { keyword: 'shop' } })

    expect(getChatSnapshot().conversations[0]?.goal?.slots).toEqual({ provider: 'vercel', keyword: 'shop' })

    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: { provider: 'netlify' } })
    expect(getChatSnapshot().conversations[0]?.goal?.slots).toEqual({ provider: 'netlify', keyword: 'shop' })
  })

  it('does not overwrite a known intent with UNKNOWN or OUT_OF_SCOPE', () => {
    const conversation = createConversation('A')
    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: {} })

    mergeConversationGoal(conversation.id, { intent: 'UNKNOWN', slots: {} })
    expect(getChatSnapshot().conversations[0]?.goal?.intent).toBe('CONNECT_WEBSITE')

    mergeConversationGoal(conversation.id, { intent: 'OUT_OF_SCOPE', slots: {} })
    expect(getChatSnapshot().conversations[0]?.goal?.intent).toBe('CONNECT_WEBSITE')
  })

  it('overwrites intent with a new, recognised intent', () => {
    const conversation = createConversation('A')
    mergeConversationGoal(conversation.id, { intent: 'CONNECT_WEBSITE', slots: {} })
    mergeConversationGoal(conversation.id, { intent: 'SEARCH_DOMAIN', slots: {} })

    expect(getChatSnapshot().conversations[0]?.goal?.intent).toBe('SEARCH_DOMAIN')
  })

  it('is a no-op for a conversation id that does not exist', () => {
    createConversation('A')
    const before = getChatSnapshot()
    mergeConversationGoal('does-not-exist', { intent: 'SEARCH_DOMAIN', slots: {} })
    expect(getChatSnapshot()).toEqual(before)
  })
})

describe('appendMessage forwards actions (v1.4 §7.6)', () => {
  it('stores actions when provided, and omits the field when not', () => {
    const conversation = createConversation('A')
    const actions: AssistantAction[] = [
      { kind: 'SET_SLOT', id: 'set-slot-provider-vercel', label: 'Vercel', payload: { slotKey: 'provider', value: 'vercel' } },
    ]
    const withActions = appendMessage(conversation.id, { role: 'assistant', content: 'x', status: 'done', actions })
    expect(withActions.actions).toEqual(actions)
    expect(getChatSnapshot().conversations[0]?.messages[0]?.actions).toEqual(actions)

    const withoutActions = appendMessage(conversation.id, { role: 'assistant', content: 'y', status: 'done' })
    expect(withoutActions).not.toHaveProperty('actions')
  })
})

describe('goal/actions survive a simulated reload (v1.4 §7.6)', () => {
  it('preserves a valid goal and per-message actions across resetChatStoreForTest()', () => {
    const conversation = createConversation('A')
    mergeConversationGoal(conversation.id, { intent: 'SEARCH_DOMAIN', slots: { keyword: 'shop' } })
    const actions: AssistantAction[] = [{ kind: 'SUGGEST_DOMAINS', id: 'suggest-domains', label: 'x', payload: { keywords: ['shop'] } }]
    appendMessage(conversation.id, { role: 'assistant', content: 'x', status: 'done', actions })

    resetChatStoreForTest()

    const reloaded = getChatSnapshot().conversations[0]
    expect(reloaded?.goal).toEqual({ intent: 'SEARCH_DOMAIN', slots: { keyword: 'shop' }, updatedAt: expect.any(Number) })
    expect(reloaded?.messages[0]?.actions).toEqual(actions)
  })

  it('discards the whole store when a stored goal is structurally invalid', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        activeConversationId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'A',
            createdAt: 0,
            updatedAt: 0,
            messages: [],
            goal: { intent: 123, slots: {}, updatedAt: 0 }, // intent must be string|null
          },
        ],
      }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot()).toEqual({ schemaVersion: 1, activeConversationId: '', conversations: [] })
  })

  it('discards the whole store when a stored message has a malformed actions entry', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        activeConversationId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'A',
            createdAt: 0,
            updatedAt: 0,
            messages: [
              { id: 'm1', role: 'assistant', content: 'x', createdAt: 0, status: 'done', actions: [{ kind: 'SET_SLOT' }] },
            ],
          },
        ],
      }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot()).toEqual({ schemaVersion: 1, activeConversationId: '', conversations: [] })
  })

  it('tolerates a conversation/message with no goal/actions at all (pre-v1.4 data)', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        activeConversationId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'A',
            createdAt: 0,
            updatedAt: 0,
            messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 0, status: 'done' }],
          },
        ],
      }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot().conversations).toHaveLength(1)
    expect(getChatSnapshot().conversations[0]?.goal).toBeUndefined()
  })
})

describe('walkthrough (plan §2/§6, FR-21)', () => {
  it('startWalkthrough attaches state to the right conversation only', () => {
    const a = createConversation('A')
    const b = createConversation('B')

    startWalkthrough(a.id, 'ADD_A_RECORD', 1000)

    const snapshot = getChatSnapshot()
    expect(snapshot.conversations.find((c) => c.id === a.id)?.walkthrough).toEqual({
      templateId: 'ADD_A_RECORD',
      completedStepIds: [],
      visitedRouteIds: [],
      startedAt: 1000,
      dismissedAt: null,
    })
    expect(snapshot.conversations.find((c) => c.id === b.id)?.walkthrough).toBeUndefined()
  })

  it('startWalkthrough is a no-op for an unknown conversation id', () => {
    createConversation('A')
    const before = getChatSnapshot()
    startWalkthrough('does-not-exist', 'ADD_A_RECORD', 1000)
    expect(getChatSnapshot()).toBe(before)
  })

  it('completeWalkthroughStep marks a step complete on the target conversation', () => {
    const conversation = createConversation('A')
    startWalkthrough(conversation.id, 'ADD_A_RECORD', 1000)

    completeWalkthroughStep(conversation.id, 'add-a-record-open')

    expect(getChatSnapshot().conversations[0]?.walkthrough?.completedStepIds).toEqual(['add-a-record-open'])
  })

  it('completeWalkthroughStep is a no-op when the conversation has no walkthrough', () => {
    const conversation = createConversation('A')
    const before = getChatSnapshot()
    completeWalkthroughStep(conversation.id, 'add-a-record-open')
    expect(getChatSnapshot()).toBe(before)
  })

  it('dismissActiveWalkthrough sets dismissedAt on that conversation only', () => {
    const a = createConversation('A')
    const b = createConversation('B')
    startWalkthrough(a.id, 'ADD_A_RECORD', 1000)
    startWalkthrough(b.id, 'ADD_A_RECORD', 1000)

    dismissActiveWalkthrough(a.id, 2000)

    const snapshot = getChatSnapshot()
    expect(snapshot.conversations.find((c) => c.id === a.id)?.walkthrough?.dismissedAt).toBe(2000)
    expect(snapshot.conversations.find((c) => c.id === b.id)?.walkthrough?.dismissedAt).toBeNull()
  })

  it('dismissActiveWalkthrough is a no-op when the conversation has no walkthrough', () => {
    const conversation = createConversation('A')
    const before = getChatSnapshot()
    dismissActiveWalkthrough(conversation.id, 2000)
    expect(getChatSnapshot()).toBe(before)
  })

  it('recordWalkthroughRouteVisit advances the ACTIVE conversation walkthrough', () => {
    const conversation = createConversation('A') // createConversation() makes it active.
    startWalkthrough(conversation.id, 'ADD_A_RECORD', 1000)

    recordWalkthroughRouteVisit('DNS_RECORDS')

    expect(getChatSnapshot().conversations[0]?.walkthrough?.visitedRouteIds).toEqual(['DNS_RECORDS'])
  })

  it('recordWalkthroughRouteVisit is a no-op (no subscriber notification) when there is no walkthrough', () => {
    createConversation('A')
    const listener = vi.fn()
    subscribeChatStore(listener)

    recordWalkthroughRouteVisit('DNS_RECORDS')

    expect(listener).not.toHaveBeenCalled()
  })

  it('recordWalkthroughRouteVisit is a no-op (no subscriber notification) when there is no active conversation', () => {
    const listener = vi.fn()
    subscribeChatStore(listener)

    recordWalkthroughRouteVisit('DNS_RECORDS')

    expect(listener).not.toHaveBeenCalled()
  })

  it('recordWalkthroughRouteVisit is a no-op (no subscriber notification) once the route was already recorded', () => {
    const conversation = createConversation('A')
    startWalkthrough(conversation.id, 'ADD_A_RECORD', 1000)
    recordWalkthroughRouteVisit('DNS_RECORDS')

    const listener = vi.fn()
    subscribeChatStore(listener)
    recordWalkthroughRouteVisit('DNS_RECORDS')

    expect(listener).not.toHaveBeenCalled()
    expect(getChatSnapshot().conversations[0]?.walkthrough?.visitedRouteIds).toEqual(['DNS_RECORDS'])
  })

  it('a walkthrough survives the simulated-reload round trip', () => {
    const conversation = createConversation('A')
    startWalkthrough(conversation.id, 'ADD_A_RECORD', 1000)
    // Order matters now: `recordWalkthroughRouteVisit` only records a visit that
    // is evidence for the CURRENT step (see `recordRouteVisit`'s doc), and
    // `add-a-record-open` - the DNS_RECORDS step - is step 1. Recording it after
    // step 1 was already completed would correctly be ignored.
    recordWalkthroughRouteVisit('DNS_RECORDS')
    completeWalkthroughStep(conversation.id, 'add-a-record-check-value')

    resetChatStoreForTest()

    const reloaded = getChatSnapshot().conversations[0]?.walkthrough
    expect(reloaded).toEqual({
      templateId: 'ADD_A_RECORD',
      completedStepIds: ['add-a-record-check-value'],
      visitedRouteIds: ['DNS_RECORDS'],
      startedAt: 1000,
      dismissedAt: null,
    })
  })

  it('rejects a corrupt walkthrough payload (discards the whole store)', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        activeConversationId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'A',
            createdAt: 0,
            updatedAt: 0,
            messages: [],
            walkthrough: { templateId: 'ADD_A_RECORD', completedStepIds: [], visitedRouteIds: [], startedAt: 'not-a-number', dismissedAt: null },
          },
        ],
      }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot()).toEqual({ schemaVersion: 1, activeConversationId: '', conversations: [] })
  })

  it('tolerates a conversation with no walkthrough at all (pre-walkthrough data)', () => {
    window.sessionStorage.setItem(
      ASSISTANT_CHAT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        activeConversationId: 'c1',
        conversations: [{ id: 'c1', title: 'A', createdAt: 0, updatedAt: 0, messages: [] }],
      }),
    )
    resetChatStoreForTest()
    expect(getChatSnapshot().conversations[0]?.walkthrough).toBeUndefined()
  })
})
