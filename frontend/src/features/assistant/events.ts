/**
 * Typed in-app event bus for the assistant feature (spec browser-ai.md §20).
 * v1 sends telemetry nowhere (§14.1, §20.1 decision) - this only exists so a
 * future KPI backend (Firebase Analytics is the current first candidate) has
 * a single, already-shaped seam to subscribe to. Never add a network call
 * here.
 */
import type { IntentId } from './routing/playbooks'
import type { RouteId } from './routing/routeManifest'

/** §20.1 verbatim, 14 members. */
export type AssistantEventType =
  | 'session_started'
  | 'route_changed'
  | 'model_load_started'
  | 'model_load_completed'
  | 'model_load_failed'
  | 'chat_opened'
  | 'chat_closed'
  | 'message_sent'
  | 'clarification_asked'
  | 'navigation_suggested'
  | 'navigation_clicked'
  | 'guard_blocked'
  | 'out_of_scope'
  | 'output_validation_failed'

/**
 * §20.1 verbatim.
 *
 * Fields that must NEVER be added here (§20.1 「含めないもの」): the full
 * user utterance, the full AI reply, a domain name, a TXT value, any DNS
 * value, uid, an email address, or a URL/query string. This constraint holds
 * for any future send target, not just the v1 console.debug subscriber.
 */
export interface AssistantEvent {
  type: AssistantEventType
  /** navigation_* = the proposed route; route_changed = the route navigated to. Manifest reverse lookup, null if none. */
  routeId?: RouteId | null
  intent?: IntentId
  durationMs?: number
}

type AssistantEventListener = (event: AssistantEvent) => void

const listeners = new Set<AssistantEventListener>()

/**
 * Fires an event to every subscriber. v1's only built-in subscriber is a
 * `console.debug` gated on `import.meta.env.DEV` - no network call is ever
 * made here (FR-17).
 */
export function emitAssistantEvent(event: AssistantEvent): void {
  if (import.meta.env.DEV) {
    console.debug('[assistant]', event)
  }
  for (const listener of listeners) listener(event)
}

/** Returns an unsubscribe function. Used by later waves' UI code and by tests. */
export function subscribeAssistantEvents(listener: AssistantEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
