/**
 * User-facing wording for the domain search screen (spec §6.7).
 * Kept in one module so the fixed phrasings cannot drift per component -
 * mirrors `features/auth/authMessages.ts`.
 */
import { isApiError } from '../../api/apiError'
import type { DomainSearchResultItem } from '../../api/domainsSearchApi'
import { messageForEppCode } from '../../api/eppResultMessages'

/** spec §6.7 EPP code 2302 wording, from the single shared mapping module. */
export const TAKEN_MESSAGE = messageForEppCode(2302) as string

/**
 * The 3rd, mandatory state (spec §6.7): a registry that could not be reached
 * must never be reported as "taken" - that would tell the user a domain they
 * could actually get is unavailable. This is the honest alternative.
 */
export const UNKNOWN_MESSAGE = '確認できませんでした。'

export const RETRY_LATER_MESSAGE = '時間をおいて再度お試しください。'

/**
 * The 4th state (docs/仕様/registry-unavailable.md §5.3): the registry
 * serving the TLD has been judged unreachable (503s sustained ~1min).
 * Unlike UNKNOWN_MESSAGE the verdict is settled and purchase is impossible
 * right now — but it is NOT claimed to be maintenance: a 503 alone cannot
 * tell maintenance from overload or a restart.
 */
export const UNAVAILABLE_MESSAGE = '一時的に購入できません。'

/** Shown once above the results when any TLD's registry is unreachable. */
export const UNAVAILABLE_NOTICE =
  'ただいま一部のレジストリに接続しづらい状況です。該当するTLD（⏳）は表示していますが、一時的に購入できません。時間をおいて改めてお試しください。'

/**
 * The 5th state: the registry serving the TLD announced a maintenance window
 * over the poll queue and it is on right now. Unlike UNAVAILABLE_MESSAGE this
 * IS allowed to say メンテナンス — it is the registry's own word, not an
 * inference from 503s (docs/仕様/registry-unavailable.md).
 */
export const MAINTENANCE_MESSAGE = 'メンテナンス中のため購入できません。'

/**
 * Shown once above the results when any TLD's registry is in announced
 * maintenance. Pass the announced end (ISO 8601) when the search response
 * carried one; the wording then names the expected recovery time.
 *
 * @param until Announced end of the window, or null when the registry gave
 *   none.
 */
export function maintenanceNotice(until: string | null): string {
  const base =
    '一部のレジストリがメンテナンス中です。該当するTLD（🔧）の検索結果は表示できず、購入もできません。'
  const endsAt = formatMaintenanceEnd(until)
  return endsAt
    ? `${base}終了予定: ${endsAt}。終了後に改めてお試しください。`
    : `${base}終了後に改めてお試しください。`
}

/** "8/30 12:00"-style local rendering of the announced end, or null. */
export function formatMaintenanceEnd(until: string | null): string | null {
  if (!until) return null
  const parsed = new Date(until)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export const TLDS_FALLBACK_NOTICE =
  '対応TLDの一覧を取得できなかったため、確認済みの一部のTLDのみ表示しています。'

/**
 * 検索そのものが失敗したとき（どのレジストリからも答えが返らず、
 * searchDomains が unavailable を投げたとき）に結果画面が出す見出し。
 *
 * 「1件も空きがなかった」ではなく「1件も確認できなかった」であることを、
 * 表の空振りとはっきり区別して言い切る。この状態でも結果画面そのものは必ず
 * 出す — 検索が無反応に見えるのが、この文言が生まれた理由そのものなので。
 */
export const SEARCH_FAILED_HEADING = '空き状況を確認できませんでした'

/** 同じ条件でもう一度引き直すボタン（assistantMessages.ts と同じ語）。 */
export const SEARCH_RETRY_BUTTON_LABEL = '再試行'

/**
 * 空き待ち登録の完了通知 (docs/仕様/domain-watch.md). Promises a NOTICE, not
 * the name: several members may watch the same domain, so "空いたら買えます"
 * would be a promise the first-come-first-served reality then breaks.
 *
 * @param domain The domain that was registered.
 */
export function watchRegisteredNotice(domain: string): string {
  return `${domain} を空き待ちに登録しました。購入できる状態を確認でき次第、マイページでお知らせします。`
}

/** undefined for 'available' - the price display covers that case instead. */
export function messageForResult(result: DomainSearchResultItem): string | undefined {
  if (result.state === 'taken') return TAKEN_MESSAGE
  if (result.state === 'unknown') return UNKNOWN_MESSAGE
  if (result.state === 'unavailable') return UNAVAILABLE_MESSAGE
  if (result.state === 'maintenance') return MAINTENANCE_MESSAGE
  return undefined
}

export function messageForSearchError(error: unknown): string {
  if (!isApiError(error)) return RETRY_LATER_MESSAGE
  if (error.kind === 'registryMaintenance') {
    // Both registries in one window (or a single-registry search): the whole
    // call failed, so the registry's own claim is the honest wording.
    return maintenanceNotice(error.maintenanceUntil)
  }
  // Everything else keeps the message ApiError already settled on: the
  // backend's own Japanese sentence when it sent one (a full registry outage
  // says 「レジストリに接続できない状態です。」 — httpsErrors.ts), otherwise the
  // per-kind default from apiError.ts. Collapsing all of them into
  // RETRY_LATER_MESSAGE, as this used to, threw away the only sentence that
  // explained WHY nothing could be checked.
  return error.message || RETRY_LATER_MESSAGE
}
