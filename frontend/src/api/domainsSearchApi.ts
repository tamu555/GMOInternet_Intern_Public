/**
 * Domain search (docs/api-flow-diagrams.html FIG.1, left half).
 *
 * Callable contract:
 *   - `searchDomains` (real, functions/src/api/searchDomains.ts):
 *       { names: string[] } (1..25, "label.tld" without the leading dot)
 *       -> { results: { name, registry, available, reason? }[], unsupported: string[],
 *            unavailable: string[] } (names whose registry is judged
 *            unreachable — circuit open, §6.9)
 *   - `listTlds` (real, functions/src/api/listTlds.ts - serves the live
 *       hello-built TLD map, spec §4.3):
 *       {} -> { tlds: string[] } (leading-dot form)
 *
 * The two-stage HTTP-status + result.code judgement (spec §3.3) and the EPP
 * error table (§6.7) stay in the backend BRIDGE layer - the browser never
 * talks to a registry directly (§3.2.1). This module only fans the label out
 * to per-TLD names and folds the merged answer back into the per-TLD result
 * items the search screen renders.
 */
import { invoke } from './callable'

export type DomainAvailabilityState =
  | 'available'
  | 'taken'
  | 'unknown'
  | 'unavailable'
  | 'maintenance'

export type DomainSearchResultItem = {
  tld: string
  domain: string
  /**
   * `unavailable` (docs/仕様/registry-unavailable.md §5.2) is deliberately a
   * 4th state, not an `unknownReason`: the registry has been JUDGED
   * unreachable (503s sustained ~1min), so purchase is impossible right now -
   * the table must render it as "not purchasable", never as a
   * transient-looking "？". A fresh, un-judged 503 never reaches this state;
   * it stays 'unknown'.
   *
   * `maintenance` is the stronger 5th state: the registry ANNOUNCED a
   * maintenance window over the poll queue and it is on right now — the one
   * case the table may word as メンテナンス中.
   */
  state: DomainAvailabilityState
  /** Present only when state === 'taken' (spec §6.7, e.g. 2302). */
  eppCode?: number
  /**
   * Present only when state === 'unknown'. `timeout` is the critical case
   * spec §6.7 calls out: one registry failing to answer must never render as
   * "taken" for the TLDs routed to it. `unsupported` means no registry serves
   * the TLD (the backend's supportedTlds map, spec §4.3).
   */
  unknownReason?: 'timeout' | 'registry-error' | 'unsupported'
}

export type DomainSearchRequest = {
  /** Already normalized (NFKC + whitespace-absorbed + trimmed), no TLD, no dots. */
  label: string
  /** One or more, leading-dot form, e.g. ".com". */
  tlds: string[]
}

export type DomainSearchResponse = {
  label: string
  results: DomainSearchResultItem[]
  /** Announced end of a maintenance window (ISO 8601), when one TLD hit one. */
  maintenanceUntil?: string | null
}

/** Wire shape of the real `searchDomains` callable (functions/src/bridge/types.ts). */
type BackendSearchResponse = {
  results: Array<{
    name: string
    registry: 'kitaqsign' | 'kitaqnic'
    available: boolean
    reason?: string
  }>
  unsupported: string[]
  /** Names whose registry is judged unreachable (circuit open, §6.9). */
  unavailable?: string[]
  /** Names whose registry announced a maintenance window that is on now. */
  maintenance?: string[]
  /** Announced end of that window (ISO 8601), when the registry gave one. */
  maintenanceUntil?: string | null
}

/** spec §6.7: only a plain numeric result.code is worth surfacing as eppCode. */
function eppCodeFromReason(reason: string | undefined): number | undefined {
  if (!reason) return undefined
  const trimmed = reason.trim()
  return /^\d{4}$/.test(trimmed) ? Number(trimmed) : undefined
}

export async function searchDomains(
  input: DomainSearchRequest,
  signal?: AbortSignal,
): Promise<DomainSearchResponse> {
  const names = input.tlds.map((tld) => `${input.label}${tld}`)
  const response = await invoke<{ names: string[] }, BackendSearchResponse>(
    'searchDomains',
    { names },
    { signal },
  )

  // The backend merges both registries into one list keyed by the normalized
  // (lowercased) full name; fold it back into the per-TLD order we asked for.
  const byName = new Map(response.results.map((item) => [item.name.toLowerCase(), item]))
  const unsupported = new Set(response.unsupported.map((name) => name.toLowerCase()))
  const unavailable = new Set((response.unavailable ?? []).map((name) => name.toLowerCase()))
  const maintenance = new Set((response.maintenance ?? []).map((name) => name.toLowerCase()))

  const results: DomainSearchResultItem[] = input.tlds.map((tld) => {
    const domain = `${input.label}${tld}`
    const key = domain.toLowerCase()
    if (unsupported.has(key)) {
      return { tld, domain, state: 'unknown', unknownReason: 'unsupported' }
    }
    if (maintenance.has(key)) {
      return { tld, domain, state: 'maintenance' }
    }
    if (unavailable.has(key)) {
      return { tld, domain, state: 'unavailable' }
    }
    const answer = byName.get(key)
    if (!answer) {
      // Not answered and not marked unsupported: treat as the honest 3rd state
      // (§6.7) rather than guessing either way.
      return { tld, domain, state: 'unknown', unknownReason: 'registry-error' }
    }
    if (answer.available) {
      return { tld, domain, state: 'available' }
    }
    const eppCode = eppCodeFromReason(answer.reason)
    return eppCode === undefined
      ? { tld, domain, state: 'taken' }
      : { tld, domain, state: 'taken', eppCode }
  })

  return { label: input.label, results, maintenanceUntil: response.maintenanceUntil ?? null }
}

export type TldListResponse = {
  tlds: string[]
}

/**
 * spec §4.3: "起動時に両レジストリの sessions/hello を叩き supportedTlds から
 * TLD→レジストリのマップを自動生成する。ハードコードしない。" Served by the
 * real `listTlds` callable, which reads the same routing map `searchDomains`
 * and `createOrder` use — so every TLD offered here is one the backend will
 * actually route.
 */
export function fetchSupportedTlds(signal?: AbortSignal): Promise<TldListResponse> {
  return invoke<Record<string, never>, TldListResponse>('listTlds', {}, { signal })
}
