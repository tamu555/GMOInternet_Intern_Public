/**
 * TLD metadata and pricing (spec §6.2.4 / §6.2.5).
 *
 * ✅ TLD sets are the MEASURED ones (spec §3.8, `sessions/hello` 実測
 * 2026-08-26, `.org` / `.info` は 2026-08-27 16:00 のレジストリ側変更で
 * Kitaqsign → Kitaqnic へ移管): Kitaqsign 2 + Kitaqnic 20. Listing anything else here makes
 * the UI advertise a TLD `createOrder` will reject with "このTLDは取り扱って
 * いません。" (functions/src/api/createOrder.ts resolves the registry from the
 * live hello-built map), so keep these arrays in sync with §3.8.
 *
 * ⚠ Prices are still placeholders (TBD #7 - the pseudo registries have no
 * billing concept, every yen figure is our own invention), but they MUST stay
 * consistent with the server-side table in functions/src/domain/pricing.ts:
 * the backend re-prices every order, and a mismatch shows the user one price
 * on the confirm screen and another on the completed order.
 */

export type RegistryId = 'kitaqsign' | 'kitaqnic'

export type TldMeta = {
  tld: string
  registry: RegistryId
  /** HSTS-preloaded TLDs that refuse to serve over plain HTTP (spec §6.2.4). */
  requiresHttps?: boolean
  /** Priced above the standard tier - shown as a caveat at suggestion time (spec §6.2.4). */
  premium?: boolean
  /** One-line note surfaced next to the TLD in results and suggestions. */
  caveat?: string
}

export type TldPricing = {
  tld: string
  firstYearYen: number
  renewalYearYen: number
  restoreYen: number
}

/** Kitaqsign's 2 TLDs — `.org` / `.info` moved to Kitaqnic on 2026-08-27
 * 16:00 (registry-side change; spec §3.8). */
const KITAQSIGN_TLDS: TldMeta[] = [
  { tld: '.com', registry: 'kitaqsign' },
  { tld: '.net', registry: 'kitaqsign' },
]

/** Kitaqnic's 20 TLDs (spec §3.8: 18 measured 2026-08-26, plus `.org` /
 * `.info` taken over from Kitaqsign on 2026-08-27 16:00). */
const KITAQNIC_TLDS: TldMeta[] = [
  { tld: '.org', registry: 'kitaqnic' },
  { tld: '.info', registry: 'kitaqnic' },
  { tld: '.xyz', registry: 'kitaqnic' },
  { tld: '.online', registry: 'kitaqnic' },
  { tld: '.site', registry: 'kitaqnic' },
  { tld: '.tech', registry: 'kitaqnic' },
  { tld: '.space', registry: 'kitaqnic' },
  { tld: '.store', registry: 'kitaqnic' },
  { tld: '.website', registry: 'kitaqnic' },
  { tld: '.press', registry: 'kitaqnic' },
  { tld: '.host', registry: 'kitaqnic' },
  { tld: '.fun', registry: 'kitaqnic' },
  { tld: '.icu', registry: 'kitaqnic' },
  { tld: '.cyou', registry: 'kitaqnic' },
  { tld: '.sbs', registry: 'kitaqnic' },
  { tld: '.bond', registry: 'kitaqnic' },
  { tld: '.cfd', registry: 'kitaqnic' },
  { tld: '.art', registry: 'kitaqnic' },
  { tld: '.build', registry: 'kitaqnic' },
  { tld: '.ceo', registry: 'kitaqnic', premium: true, caveat: 'プレミアム価格のTLDです。' },
]

export const TLD_METADATA: TldMeta[] = [...KITAQSIGN_TLDS, ...KITAQNIC_TLDS]

function price(tld: string, firstYearYen: number, renewalYearYen: number, restoreYen: number): TldPricing {
  return { tld, firstYearYen, renewalYearYen, restoreYen }
}

/**
 * ⚠ PLACEHOLDER prices (TBD #7) - entirely our own invention, no real billing
 * exists. Keep in sync with functions/src/domain/pricing.ts (server re-prices).
 */
export const TLD_PRICING: TldPricing[] = [
  price('.com', 1480, 1980, 3300),
  price('.net', 1680, 2180, 3300),
  price('.org', 1680, 2180, 3300),
  price('.info', 980, 2480, 3300),
  price('.xyz', 98, 1980, 3300),
  price('.online', 180, 5480, 3300),
  price('.site', 180, 3980, 3300),
  price('.tech', 480, 5980, 3300),
  price('.space', 280, 2980, 3300),
  price('.store', 280, 5980, 3300),
  price('.website', 380, 3480, 3300),
  price('.press', 980, 7980, 3300),
  price('.host', 1280, 6980, 3300),
  price('.fun', 280, 2980, 3300),
  price('.icu', 98, 1280, 3300),
  price('.cyou', 98, 1180, 3300),
  price('.sbs', 198, 1780, 3300),
  price('.bond', 480, 2480, 3300),
  price('.cfd', 380, 2280, 3300),
  price('.art', 780, 2480, 3300),
  price('.build', 1480, 4980, 3300),
  price('.ceo', 3980, 6980, 4400),
]

const metaByTld = new Map(TLD_METADATA.map((meta) => [meta.tld, meta]))
const pricingByTld = new Map(TLD_PRICING.map((pricing) => [pricing.tld, pricing]))

export function getTldMeta(tld: string): TldMeta | undefined {
  return metaByTld.get(tld)
}

export function getTldPricing(tld: string): TldPricing | undefined {
  return pricingByTld.get(tld)
}

/**
 * The price actually charged for a TLD the table above does not list: the
 * backend (functions/src/domain/pricing.ts DEFAULT_PRICE) falls back to these
 * figures rather than rejecting the order, so the registry can serve TLDs the
 * table has not caught up with. MUST stay equal to that server-side default,
 * or the confirm screen shows one price and the order charges another.
 */
function defaultTldPricing(tld: string): TldPricing {
  return { tld, firstYearYen: 1500, renewalYearYen: 1500, restoreYen: 8000 }
}

/**
 * Pricing for the purchase/display paths, which must quote every TLD the
 * registry actually serves (the live `listTlds` set can outgrow the table
 * above): unknown TLDs get the server's default price instead of `undefined`.
 *
 * The assistant/suggest code keeps using {@link getTldPricing}: there,
 * `undefined` deliberately means "not in our curated catalogue, do not
 * proactively recommend it".
 */
export function getTldPricingOrDefault(tld: string): TldPricing {
  return pricingByTld.get(tld) ?? defaultTldPricing(tld)
}

export function registryForTld(tld: string): RegistryId | undefined {
  return metaByTld.get(tld)?.registry
}

export function threeYearTotalYen(pricing: TldPricing): number {
  return pricing.firstYearYen + pricing.renewalYearYen * 2
}

export function formatYen(amountYen: number): string {
  return `¥${amountYen.toLocaleString('ja-JP')}`
}
