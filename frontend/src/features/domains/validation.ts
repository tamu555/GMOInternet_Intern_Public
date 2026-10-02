/**
 * Client-side validation for the domain search form (spec §3.4).
 *
 * Mirrors `features/auth/validation.ts`: this corrects the user in the form
 * instead of letting a guaranteed 400 come back from the registry. The
 * backend still validates - this is a UX layer, not a security boundary.
 */
import { DOMAIN_LABEL_MAX_LENGTH, DOMAIN_LABEL_PATTERN } from './constants'

export type DomainSearchFormValues = {
  label: string
  tlds: string[]
}

export type DomainSearchFormErrors = {
  label?: string
  tlds?: string
}

/**
 * Absorbs the two most common accidental inputs (spec: "全角文字・全角スペー
 * ス・前後の空白の混入をフォーム側で吸収する"): NFKC folds full-width
 * alphanumerics/hyphen down to half-width, and every whitespace character
 * (including the full-width space U+3000, which NFKC turns into a plain
 * space) is stripped rather than merely trimmed - a domain label never
 * legitimately contains internal spaces.
 *
 * Call this on blur and immediately before submit, not on every keystroke:
 * transforming text mid IME-composition would corrupt Japanese input that is
 * still being composed.
 */
export function normalizeDomainLabel(rawLabel: string): string {
  return rawLabel.normalize('NFKC').replace(/\s+/g, '')
}

export function validateDomainLabel(label: string): string | undefined {
  if (!label) return 'ドメイン名を入力してください。'
  if (label.includes('.')) {
    return 'TLD（.com など）を含めず、ドメイン名の部分だけを入力してください。'
  }
  if (label.length > DOMAIN_LABEL_MAX_LENGTH) {
    return `${DOMAIN_LABEL_MAX_LENGTH}文字以内で入力してください。`
  }
  if (!DOMAIN_LABEL_PATTERN.test(label)) {
    return '英数字とハイフンのみ使用できます。'
  }
  if (label.startsWith('-') || label.endsWith('-')) {
    return 'ハイフンで始めたり終えたりすることはできません。'
  }
  return undefined
}

function validateTlds(tlds: string[]): string | undefined {
  if (tlds.length === 0) return 'TLDを1つ以上選択してください。'
  return undefined
}

/** Expects an already-normalized label (call `normalizeDomainLabel` first). */
export function validateDomainSearchForm(values: DomainSearchFormValues): DomainSearchFormErrors {
  const errors: DomainSearchFormErrors = {}

  const labelError = validateDomainLabel(values.label)
  if (labelError) errors.label = labelError

  const tldsError = validateTlds(values.tlds)
  if (tldsError) errors.tlds = tldsError

  return errors
}
