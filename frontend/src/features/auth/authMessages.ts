/**
 * User-facing wording for the auth screens.
 * Kept in one module so the fixed phrasings from FIG.6 cannot drift per screen.
 */
import { isApiError } from '../../api/apiError'
import type { FieldErrors } from '../../api/apiError'

/**
 * FIG.6: authentication failure must NOT reveal whether the e-mail or the
 * password was wrong. This prevents probing for existing accounts - do not
 * "improve" this message.
 */
export const LOGIN_FAILED_MESSAGE = 'メールアドレスまたはパスワードが違います。'

/** FIG.6: 5xx wording. */
export const RETRY_LATER_MESSAGE = '時間をおいて再度お試しください。'

export const EMAIL_TAKEN_MESSAGE =
  'このメールアドレスはすでに登録されています。ログイン画面からお進みください。'

export const SESSION_CHECK_FAILED_MESSAGE =
  'ログイン状態を確認できませんでした。通信環境を確認して、もう一度お試しください。'

export function messageForLoginError(error: unknown): string {
  if (!isApiError(error)) return RETRY_LATER_MESSAGE
  if (error.kind === 'unauthorized') return LOGIN_FAILED_MESSAGE
  if (error.kind === 'validation') return error.message
  return RETRY_LATER_MESSAGE
}

export function messageForRegisterError(error: unknown): string {
  if (!isApiError(error)) return RETRY_LATER_MESSAGE
  if (error.kind === 'conflict') return EMAIL_TAKEN_MESSAGE
  if (error.kind === 'validation') return error.message
  return RETRY_LATER_MESSAGE
}

/** Field-level messages returned by the backend on 400, if any. */
export function fieldErrorsFromApiError(error: unknown): FieldErrors {
  if (!isApiError(error) || !error.fieldErrors) return {}
  return error.fieldErrors
}
