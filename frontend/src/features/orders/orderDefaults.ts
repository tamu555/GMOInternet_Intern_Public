/**
 * Default values for the fields easy mode hides (spec §6.2.6, TBD #5).
 *
 * ⚠ PLACEHOLDER DATA. The defaults below follow the spec's own proposal
 * column so the form is exercisable now. Kept as one data object (mirroring
 * features/domains/tldData.ts for the price table, TBD #7) so resolving
 * TBD #5 is a data swap in this file only - no component changes.
 *
 * These defaults matter in BOTH modes (spec §1.2): normal mode pre-fills the
 * folded "くわしい設定" section with them; easy mode will not render those
 * sections at all but still submits them, so the payload is always complete.
 *
 * NAMESERVERS are the one field with no default (decision 2026-08-26): the
 * in-house DNS of §6.3 does not exist yet, and shipping placeholder hostnames
 * meant every purchase asked the registry to delegate to a nameserver nobody
 * runs. An order therefore carries no nameserver unless the member typed one;
 * the domain is registered in the documented `inactive` status and the DNS
 * screen sets the delegation afterwards, so a DNS detail can never cost
 * someone the domain they paid for.
 */

export type OrderFormDefaults = {
  /** 登録期間 (year). */
  registrationYears: number
  /** 自動更新 (§3.6). */
  autoRenew: boolean
  /** ネームサーバは指定しない = 取得直後は inactive（あとから設定）. */
  nameserverMode: 'none'
  /** authInfo 自動生成の文字数 (§6.2.6: 英数記号20文字以上, §3.4: ≤64). */
  authInfoLength: number
  /** registrant = 会員のコンタクトを自動使用 (§5.1: 1会員1コンタクト). */
  registrantSource: 'member-contact'
  /** admin / tech / billing は registrant と同一. */
  adminTechBillingSameAsRegistrant: boolean
}

export const ORDER_FORM_DEFAULTS: OrderFormDefaults = {
  registrationYears: 1,
  autoRenew: true,
  nameserverMode: 'none',
  authInfoLength: 24,
  registrantSource: 'member-contact',
  adminTechBillingSameAsRegistrant: true,
}

/** 登録期間 choices offered by the form (Period unit "year", spec TBD #3). */
export const REGISTRATION_YEAR_OPTIONS = [1, 2, 3, 5] as const

/** Alphanumerics + symbols (§6.2.6 "英数記号"), all safe inside JSON/EPP. */
const AUTH_INFO_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%*+-=_'

/**
 * Auto-generates the transfer passphrase (spec §6.2.6). The result always
 * satisfies §3.4 (1-64 chars); the user may still edit it in the folded
 * "くわしい設定" section.
 */
export function generateAuthInfo(length: number = ORDER_FORM_DEFAULTS.authInfoLength): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let result = ''
  for (const value of bytes) {
    result += AUTH_INFO_CHARSET[value % AUTH_INFO_CHARSET.length]
  }
  return result
}
