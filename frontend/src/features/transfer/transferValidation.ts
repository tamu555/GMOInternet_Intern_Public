/**
 * Client-side validation for the transfer-in form (spec §3.4).
 *
 * Same stance as features/domains/validation.ts: correct the user in the form
 * instead of letting a guaranteed 400 come back. Unlike the search form (label
 * only), transfer-in takes a FULL domain name — the user copies it from the
 * previous registrar's screen, dots included.
 */

const DOMAIN_MAX_LENGTH = 253
const LABEL_MAX_LENGTH = 63
const LABEL_PATTERN = /^[a-zA-Z0-9-]+$/
const AUTH_INFO_MAX_LENGTH = 64

export type TransferInFormValues = {
  domainName: string
  authInfo: string
}

export type TransferInFormErrors = {
  domainName?: string
  authInfo?: string
}

/**
 * NFKC folds full-width input down to half-width; every whitespace character
 * is stripped (a domain never legitimately contains spaces); a trailing dot
 * (FQDN notation, easy to copy along) is dropped; lowercased for the wire.
 * Call on blur / before submit, not per keystroke (IME composition).
 */
export function normalizeTransferDomainName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, '').replace(/\.$/, '').toLowerCase()
}

/** AuthCode is pasted verbatim; only the surrounding copy-paste whitespace goes. */
export function normalizeAuthInfo(raw: string): string {
  return raw.trim()
}

/** Expects an already-normalized name (call `normalizeTransferDomainName` first). */
export function validateTransferDomainName(name: string): string | undefined {
  if (!name) return '移管したいドメイン名を入力してください。'
  if (!name.includes('.')) {
    return 'TLD（.com など）まで含めたドメイン名を入力してください。例: example.com'
  }
  if (name.length > DOMAIN_MAX_LENGTH) {
    return `ドメイン名は${DOMAIN_MAX_LENGTH}文字以内で入力してください。`
  }
  const labels = name.split('.')
  for (const label of labels) {
    if (label.length === 0) return 'ドメイン名の形式が正しくありません。ドットの位置を確認してください。'
    if (label.length > LABEL_MAX_LENGTH) {
      return `各ラベルは${LABEL_MAX_LENGTH}文字以内で入力してください。`
    }
    if (!LABEL_PATTERN.test(label)) return '英数字とハイフン、ドットのみ使用できます。'
    if (label.startsWith('-') || label.endsWith('-')) {
      return 'ラベルをハイフンで始めたり終えたりすることはできません。'
    }
  }
  return undefined
}

export function validateAuthInfo(authInfo: string): string | undefined {
  if (!authInfo) return 'AuthCode（認証コード）を入力してください。'
  if (authInfo.length > AUTH_INFO_MAX_LENGTH) {
    return `認証コードは${AUTH_INFO_MAX_LENGTH}文字以内です。コピーした範囲を確認してください。`
  }
  return undefined
}

/** Expects already-normalized values. */
export function validateTransferInForm(values: TransferInFormValues): TransferInFormErrors {
  const errors: TransferInFormErrors = {}
  const domainError = validateTransferDomainName(values.domainName)
  if (domainError) errors.domainName = domainError
  const authError = validateAuthInfo(values.authInfo)
  if (authError) errors.authInfo = authError
  return errors
}
