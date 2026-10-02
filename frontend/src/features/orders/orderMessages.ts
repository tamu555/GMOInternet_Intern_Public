/**
 * User-facing wording for the order flow (FIG.1 right half, spec §5 / §6.7).
 * One module so the spec-fixed phrasings cannot drift per component -
 * mirrors features/auth/authMessages.ts.
 */
import { isApiError } from '../../api/apiError'
import { messageForEppCode } from '../../api/eppResultMessages'

/** spec §6.7: the retrying state has this exact wording... */
export const RETRYING_MESSAGE = '処理中です。自動で再試行しています。'

/** ...plus an explicit no-double-charge assurance (§6.7 二重課金しない). */
export const NO_DOUBLE_CHARGE_MESSAGE = 'お支払いが二重に発生することはありません。'

/**
 * spec §5: the user sees "処理できませんでした" - the internal refund
 * treatment (返金扱い) is never surfaced. Do not add the word 返金 here.
 */
export const ORDER_FAILED_MESSAGE = '処理できませんでした。'

export const ORDER_FAILED_NO_CHARGE_MESSAGE = 'このご注文の料金が請求されることはありません。'

export const PROVISIONING_MESSAGE = 'ドメインの登録処理を行っています…'

/** kind=renew (FIG.10): same flow, renewal wording. */
export const RENEW_PROVISIONING_MESSAGE = 'ドメインの更新処理を行っています…'

export const ORDER_NOT_FOUND_MESSAGE = 'ご指定の注文が見つかりませんでした。'

export const ORDER_STATUS_UNAVAILABLE_MESSAGE =
  '注文状況を確認できていません。自動で再確認しています。しばらく待っても表示されない場合は、通信環境を確認して再読み込みしてください。'

/** spec §2.2: no real billing exists - the payment step must say so. */
export const PSEUDO_PAYMENT_NOTICE =
  'これは疑似決済です。実際の請求・課金は発生しません。'

export const RETRY_LATER_MESSAGE = '時間をおいて再度お試しください。'

export const AUTH_INFO_COPIED_MESSAGE = '認証コードをコピーしました。'

export const AUTH_INFO_COPY_FAILED_MESSAGE =
  'コピーできませんでした。お使いのブラウザではこの機能を利用できない可能性があります。'

/** spec §3.5: NS未設定 (inactive) の説明。DNS設定への誘導と対で表示する。 */
export const INACTIVE_DOMAIN_NOTICE =
  'このドメインはまだインターネットに公開されていません。ネームサーバ（DNS）の設定が完了すると公開されます。'

export function messageForOrderCreateError(error: unknown): string {
  if (!isApiError(error)) return RETRY_LATER_MESSAGE
  if (error.kind === 'validation') return error.message
  // The two judged registry states carry their own settled wording — the
  // registry's announced maintenance, or the circuit-open unreachable state
  // (docs/仕様/registry-unavailable.md). A generic retry-later would hide
  // that retrying now is known to be pointless.
  if (error.kind === 'registryMaintenance' || error.kind === 'registryUnavailable') {
    return error.message
  }
  return RETRY_LATER_MESSAGE
}

/**
 * Supplementary reason on the failed screen, when the backend surfaced an EPP
 * result.code (contract un-agreed - see api/eppResultMessages.ts). Timeout-
 * driven failures carry no code and show only ORDER_FAILED_MESSAGE.
 */
export function failureReasonForResultCode(resultCode: number | undefined): string | undefined {
  return messageForEppCode(resultCode)
}
