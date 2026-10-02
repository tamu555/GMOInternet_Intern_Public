/**
 * Form state model for the application form (FIG.1 右半分, spec §6.2.6 / §3.4).
 *
 * The state always holds a COMPLETE set of values, pre-filled with the
 * §6.2.6 defaults (spec §1.2: masking hides sections by not rendering them,
 * never by dropping their values - the submit payload must stay complete even
 * when every advanced section is hidden).
 */
import type { OrderCreateRequest } from '../../api/ordersApi'
import { getTldPricingOrDefault, type TldPricing } from '../domains/tldData'
import { generateAuthInfo, ORDER_FORM_DEFAULTS, REGISTRATION_YEAR_OPTIONS } from './orderDefaults'

export const AUTH_INFO_MIN_LENGTH = 1
export const AUTH_INFO_MAX_LENGTH = 64
const HOSTNAME_MAX_LENGTH = 255
const HOSTNAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/

/**
 * 'none' = ネームサーバを指定しないで取得する (default). The domain lands in
 * `inactive` and the member points it somewhere from the DNS screen later.
 */
export type NameserverMode = 'none' | 'custom'

export type OrderFormValues = {
  years: number
  autoRenew: boolean
  nameserverMode: NameserverMode
  /** Used only when nameserverMode === 'custom'. */
  customNameservers: [string, string]
  authInfo: string
  /** admin / tech / billing = registrant と同一 (§6.2.6 default: true). */
  contactsSameAsRegistrant: boolean
}

export type OrderFormErrors = {
  authInfo?: string
  customNameservers?: string
}

/** §6.2.6 defaults, authInfo freshly auto-generated per form instance. */
export function buildInitialOrderFormValues(): OrderFormValues {
  return {
    years: ORDER_FORM_DEFAULTS.registrationYears,
    autoRenew: ORDER_FORM_DEFAULTS.autoRenew,
    nameserverMode: ORDER_FORM_DEFAULTS.nameserverMode,
    customNameservers: ['', ''],
    authInfo: generateAuthInfo(),
    contactsSameAsRegistrant: ORDER_FORM_DEFAULTS.adminTechBillingSameAsRegistrant,
  }
}

function validateAuthInfo(authInfo: string): string | undefined {
  if (authInfo.length < AUTH_INFO_MIN_LENGTH || authInfo.length > AUTH_INFO_MAX_LENGTH) {
    return `認証コード（authInfo）は${AUTH_INFO_MIN_LENGTH}〜${AUTH_INFO_MAX_LENGTH}文字で入力してください。`
  }
  return undefined
}

function validateCustomNameservers(nameservers: [string, string]): string | undefined {
  const filled = nameservers.map((ns) => ns.trim()).filter((ns) => ns.length > 0)
  if (filled.length === 0) return 'ネームサーバのホスト名を1つ以上入力してください。'
  for (const ns of filled) {
    if (ns.length > HOSTNAME_MAX_LENGTH || !HOSTNAME_PATTERN.test(ns)) {
      return 'ホスト名の形式（例: ns1.example.com）で入力してください。'
    }
  }
  return undefined
}

/** spec §3.4 constraints. Folded sections are validated too - they will be shown on error. */
export function validateOrderForm(values: OrderFormValues): OrderFormErrors {
  const errors: OrderFormErrors = {}

  const authInfoError = validateAuthInfo(values.authInfo)
  if (authInfoError) errors.authInfo = authInfoError

  if (values.nameserverMode === 'custom') {
    const nsError = validateCustomNameservers(values.customNameservers)
    if (nsError) errors.customNameservers = nsError
  }

  return errors
}

/**
 * Builds the ALWAYS-complete payload (spec §1.2): every contact role is
 * filled even while the section that could change them is folded away or (in
 * easy mode) not rendered.
 *
 * "Complete" is not "non-empty": in the default 'none' mode the nameserver
 * list is deliberately empty, because that is what the member asked for.
 */
export function buildOrderCreateRequest(domainName: string, values: OrderFormValues): OrderCreateRequest {
  const nameservers =
    values.nameserverMode === 'none'
      ? []
      : values.customNameservers.map((ns) => ns.trim()).filter((ns) => ns.length > 0)

  return {
    kind: 'create',
    domainName,
    years: values.years,
    autoRenew: values.autoRenew,
    nameserverMode: values.nameserverMode,
    nameservers,
    authInfo: values.authInfo,
    contacts: {
      registrant: 'member-contact',
      admin: 'member-contact',
      tech: 'member-contact',
      billing: 'member-contact',
    },
  }
}

/** 初年度 + 更新料 × (years - 1). Pure display estimate - the backend re-prices. */
export function totalPriceYen(pricing: TldPricing, years: number): number {
  return pricing.firstYearYen + pricing.renewalYearYen * Math.max(0, years - 1)
}

export function isRegistrationYearOption(years: number): boolean {
  return (REGISTRATION_YEAR_OPTIONS as readonly number[]).includes(years)
}

export type ParsedDomainName = {
  domainName: string
  label: string
  tld: string
  pricing: TldPricing
}

/**
 * Splits "myshop.dev" into label + leading-dot TLD and resolves its pricing.
 * Returns null only when the query-parameter domain is missing or
 * undecomposable - the page then sends the user back to search.
 *
 * A TLD outside the local price table is NOT rejected here: the registry's
 * live TLD list (`listTlds`) can outgrow the table, and the backend both
 * accepts such orders (at its default price) and remains the authority that
 * rejects a TLD no registry actually serves.
 */
export function parseOrderableDomain(rawDomain: string | null): ParsedDomainName | null {
  const domainName = rawDomain?.trim().toLowerCase() ?? ''
  const dotIndex = domainName.indexOf('.')
  if (!domainName || dotIndex <= 0 || dotIndex === domainName.length - 1) return null

  const label = domainName.slice(0, dotIndex)
  const tld = domainName.slice(dotIndex)
  const pricing = getTldPricingOrDefault(tld)

  return { domainName, label, tld, pricing }
}
