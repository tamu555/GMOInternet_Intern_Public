/**
 * Client-side validation for the login form.
 *
 * The user is corrected in the form instead of by a 400 from the backend. The
 * backend still validates — this is a UX layer, not a security boundary.
 *
 * The address is validated as ONE value. The old split (free local part + a
 * fixed `@example.com` pulldown) is gone: the closed domain list is a
 * registration rule and lives in `features/signup/accountSchema.ts`. Sign-in
 * only asks "is this a well-formed address"; whether an account exists behind
 * it is answered by the 401, which never says which half was wrong (FIG.6).
 */

export type LoginFormValues = {
  email: string
  password: string
}

export type FormErrors<T> = Partial<Record<keyof T, string>>

/** RFC 5321 caps a path at 256 octets including the angle brackets. */
export const EMAIL_MAX_LENGTH = 254

export const EMAIL_REQUIRED_MESSAGE = 'メールアドレスを入力してください。'
export const EMAIL_INVALID_MESSAGE = '正しいメールアドレスを入力してください。'

/**
 * A deliberately conservative subset of RFC 5322: a dot-atom local part, then
 * a domain of at least two dot-separated labels ending in an alphabetic TLD.
 * It rejects everything a typo produces (`taro`, `taro@`, `taro@example`,
 * `taro@@example.com`, a trailing dot) without rejecting real addresses.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+\-/=?^_{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_{|}~]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/

/** `undefined` when the address is usable, otherwise the message to show. */
export function validateEmail(rawEmail: string): string | undefined {
  const email = rawEmail.trim()
  if (!email) return EMAIL_REQUIRED_MESSAGE
  if (email.length > EMAIL_MAX_LENGTH) return EMAIL_INVALID_MESSAGE
  if (!EMAIL_PATTERN.test(email)) return EMAIL_INVALID_MESSAGE
  return undefined
}

export function validateLoginForm(values: LoginFormValues): FormErrors<LoginFormValues> {
  const errors: FormErrors<LoginFormValues> = {}

  const emailError = validateEmail(values.email)
  if (emailError) errors.email = emailError

  if (!values.password) errors.password = 'パスワードを入力してください。'

  return errors
}
