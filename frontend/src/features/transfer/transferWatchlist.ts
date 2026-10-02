/**
 * Which 移管IN this tab is still waiting on an answer for (FIG.9 結果行).
 *
 * Why this exists: the real `listTransfers` returns PENDING transfers only, so
 * a transfer that the losing registrar approved or rejected simply disappears
 * from the list. FIG.9 requires the opposite — 「approved / rejected = 結果行
 * （ユーザーが閉じるまで残る）」 — so the my-page section has to know which
 * domains to ask `getTransferStatus` about after they leave the pending list.
 *
 * sessionStorage, deliberately:
 *   - it survives the /mypage/transfer → /mypage navigation and a reload, which
 *     is the whole point (the answer usually arrives minutes later);
 *   - it dies with the tab, so a name can never be watched forever;
 *   - it is per-browser bookkeeping, not domain state — the backend record
 *     (`transfers/{uid}__{domain}`) stays the only source of truth.
 *
 * Storage failures (Safari private mode, quota) are swallowed: losing the
 * result row is a cosmetic degradation, never a reason to break my-page.
 */

const STORAGE_KEY = 'transfer-in-watchlist'

function read(): string[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((name): name is string => typeof name === 'string')
  } catch {
    return []
  }
}

function write(names: string[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(names))
  } catch {
    // Ignored on purpose: see the module comment.
  }
}

/** Domains whose 移管IN outcome this tab still wants to show. */
export function watchedTransferIns(): string[] {
  return read()
}

/** Starts watching a domain (申請直後、または一覧で pending を見たとき). */
export function watchTransferIn(domainName: string): void {
  const names = read()
  if (names.includes(domainName)) return
  write([...names, domainName])
}

/** Stops watching: the user closed the result row, or took the request back. */
export function unwatchTransferIn(domainName: string): void {
  const names = read()
  if (!names.includes(domainName)) return
  write(names.filter((name) => name !== domainName))
}
