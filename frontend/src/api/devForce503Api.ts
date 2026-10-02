/**
 * Dev-only lever for the registry 503 fault injection
 * (functions/src/api/devForceRegistry503.ts, docs/仕様/registry-unavailable.md).
 *
 * Only the MockControlPanel calls this. The backend refuses outside the
 * emulator, so a production build carrying this module is harmless.
 */
import { invoke } from './callable'

export type Force503Registry = 'kitaqsign' | 'kitaqnic'

export type DevForce503State = {
  /** Which registries are currently forced to answer 503. */
  flags: Record<Force503Registry, boolean>
  /** When each active flag switches itself off (ISO; null while off). */
  expiresAt: Record<Force503Registry, string | null>
  /** The circuit breaker's verdict per registry. */
  health: Record<Force503Registry, 'ok' | 'unavailable'>
}

export function fetchForce503State(signal?: AbortSignal): Promise<DevForce503State> {
  return invoke<{ action: 'get' }, DevForce503State>('devForceRegistry503', { action: 'get' }, { signal })
}

export function setForce503(registry: Force503Registry, enabled: boolean): Promise<DevForce503State> {
  return invoke<{ action: 'set'; registry: Force503Registry; enabled: boolean }, DevForce503State>(
    'devForceRegistry503',
    { action: 'set', registry, enabled },
  )
}
