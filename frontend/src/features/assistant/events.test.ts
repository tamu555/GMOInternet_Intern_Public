import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitAssistantEvent, subscribeAssistantEvents } from './events'

describe('assistant event bus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers emitted events to subscribers', () => {
    const received: unknown[] = []
    const unsubscribe = subscribeAssistantEvents((event) => received.push(event))

    emitAssistantEvent({ type: 'chat_opened' })

    expect(received).toEqual([{ type: 'chat_opened' }])
    unsubscribe()
  })

  it('stops delivering events after unsubscribe', () => {
    const received: unknown[] = []
    const unsubscribe = subscribeAssistantEvents((event) => received.push(event))
    unsubscribe()

    emitAssistantEvent({ type: 'chat_closed' })

    expect(received).toEqual([])
  })

  it('supports multiple independent subscribers', () => {
    const a: unknown[] = []
    const b: unknown[] = []
    const unsubscribeA = subscribeAssistantEvents((event) => a.push(event))
    const unsubscribeB = subscribeAssistantEvents((event) => b.push(event))

    emitAssistantEvent({ type: 'message_sent', durationMs: 42 })

    expect(a).toEqual([{ type: 'message_sent', durationMs: 42 }])
    expect(b).toEqual([{ type: 'message_sent', durationMs: 42 }])
    unsubscribeA()
    unsubscribeB()
  })

  it('never performs a network call when emitting an event', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())

    emitAssistantEvent({ type: 'navigation_suggested', routeId: 'DNS_RECORDS', intent: 'CONNECT_WEBSITE' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
