/**
 * 空き待ち通知 (domain watch, "空いたらお知らせ") — the single client for the
 * watch callables in `functions/src/api/watchCallables.ts`.
 *
 *   | callable      | request          | answer                          |
 *   |---------------|------------------|---------------------------------|
 *   | `addWatch`    | `{domainName}`   | `{watch, alreadyWatching}`      |
 *   | `listWatches` | `{}`             | `{watches}` (newest first)      |
 *   | `cancelWatch` | `{domainName}`   | `{ok}`                          |
 *
 * A watch is NOT a reservation and charges nothing: the backend sweep
 * re-checks the name and flips the watch to `available` when the registry
 * confirms it free; buying then happens through the ordinary order flow.
 * Several members may watch one name, so an `available` notice is an
 * invitation, not a guarantee — the wording that accompanies it must keep
 * saying 空き状況は変動する.
 *
 * ⚠️ Keyed by `domainName`, like the transfer callables: the backend
 * document id is `${uid}__${domainName}`, so one member has at most one
 * watch per name and a double-submit lands on the existing one
 * (`alreadyWatching: true`, not an error).
 */
import { invoke } from './callable'
import type { RegistryId } from './myDomainsApi'

/** Where a watch stands (`functions/src/domain/watches.ts`). */
export type WatchState = 'watching' | 'available' | 'fulfilled' | 'expired' | 'cancelled'

/** Client-safe view of one watch (WatchSummary in functions/). */
export type DomainWatch = {
  domainName: string
  registry: RegistryId
  state: WatchState
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601 — the watch stops being checked past this. */
  expiresAt: string
  /** ISO 8601, set while `state === 'available'`; null otherwise. */
  availableAt: string | null
}

/** Watches that still occupy one of the member's slots. */
export function isActiveWatch(watch: Pick<DomainWatch, 'state'>): boolean {
  return watch.state === 'watching' || watch.state === 'available'
}

/**
 * 空き待ちの登録. Registering a name already being watched is answered with
 * the existing watch (`alreadyWatching: true`) rather than an error.
 */
export async function addDomainWatch(
  domainName: string,
): Promise<{ watch: DomainWatch; alreadyWatching: boolean }> {
  return invoke<{ domainName: string }, { watch: DomainWatch; alreadyWatching: boolean }>(
    'addWatch',
    { domainName },
  )
}

/** Every watch of the member's, cancelled ones omitted, newest first. */
export async function fetchDomainWatches(signal?: AbortSignal): Promise<DomainWatch[]> {
  const result = await invoke<Record<string, never>, { watches: DomainWatch[] }>(
    'listWatches',
    {},
    { signal },
  )
  return result.watches
}

/** 空き待ちの解除. */
export async function cancelDomainWatch(domainName: string): Promise<void> {
  await invoke<{ domainName: string }, { ok: boolean }>('cancelWatch', { domainName })
}
