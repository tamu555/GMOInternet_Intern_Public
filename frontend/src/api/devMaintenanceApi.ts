/**
 * Dev-only lever for the announced-maintenance simulation
 * (functions/src/api/devRegistryMaintenance.ts,
 * docs/仕様/registry-unavailable.md §3.5 / §7).
 *
 * Only the MockControlPanel calls this. The backend refuses outside the
 * emulator, so a production build carrying this module is harmless.
 */
import { invoke } from './callable'
import type { Force503Registry } from './devForce503Api'

export type DevMaintenanceSummary = {
  active: boolean
  windowStart: string | null
  windowEnd: string | null
  msgType: string | null
  note: string | null
}

export type DevMaintenanceState = {
  maintenance: Record<Force503Registry, DevMaintenanceSummary>
}

export function fetchMaintenanceState(signal?: AbortSignal): Promise<DevMaintenanceState> {
  return invoke<{ action: 'get' }, DevMaintenanceState>(
    'devRegistryMaintenance',
    { action: 'get' },
    { signal },
  )
}

export function startMaintenanceWindow(
  registry: Force503Registry,
  durationMinutes: number,
): Promise<DevMaintenanceState> {
  return invoke<
    { action: 'set'; registry: Force503Registry; durationMinutes: number },
    DevMaintenanceState
  >('devRegistryMaintenance', { action: 'set', registry, durationMinutes })
}

export function clearMaintenanceWindow(registry: Force503Registry): Promise<DevMaintenanceState> {
  return invoke<{ action: 'clear'; registry: Force503Registry }, DevMaintenanceState>(
    'devRegistryMaintenance',
    { action: 'clear', registry },
  )
}
