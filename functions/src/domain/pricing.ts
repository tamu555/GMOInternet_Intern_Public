/**
 * Price lookup.
 *
 * TBD #7 in the spec: the real 22-TLD price table is not decided yet. The
 * numbers below are placeholders so the order flow can be built and demoed
 * end to end. What matters structurally is that the price is decided on the
 * server: a client-supplied amount would let anyone register for one yen.
 *
 * The table covers the MEASURED TLD set (spec §3.8, `sessions/hello` 実測
 * 2026-08-26: Kitaqsign 4 + Kitaqnic 18) and must stay consistent with the
 * display table in frontend/src/features/domains/tldData.ts — the confirm
 * screen shows the frontend figures, then this module decides what the order
 * actually costs.
 */
import {tldOf} from "../bridge/registryRouter";

/** Per-TLD placeholder pricing: first year / renewal year / restore. */
interface TldPrice {
  firstYearYen: number;
  renewalYearYen: number;
  restoreYen: number;
}

/**
 * Charged for any TLD the table below does not list (the registries' live
 * TLD set can outgrow it). Must stay equal to the frontend's fallback in
 * frontend/src/features/domains/tldData.ts (`getTldPricingOrDefault`), or the
 * confirm screen quotes one price and the order charges another.
 */
const DEFAULT_PRICE: TldPrice = {
  firstYearYen: 1500,
  renewalYearYen: 1500,
  restoreYen: 8000,
};

/**
 * Placeholder per-TLD prices (TBD #7). Keys are bare TLD labels.
 * Keep in sync with frontend/src/features/domains/tldData.ts.
 */
const PRICE_TABLE_YEN: Record<string, TldPrice> = {
  com: {firstYearYen: 1480, renewalYearYen: 1980, restoreYen: 3300},
  net: {firstYearYen: 1680, renewalYearYen: 2180, restoreYen: 3300},
  org: {firstYearYen: 1680, renewalYearYen: 2180, restoreYen: 3300},
  info: {firstYearYen: 980, renewalYearYen: 2480, restoreYen: 3300},
  xyz: {firstYearYen: 98, renewalYearYen: 1980, restoreYen: 3300},
  online: {firstYearYen: 180, renewalYearYen: 5480, restoreYen: 3300},
  site: {firstYearYen: 180, renewalYearYen: 3980, restoreYen: 3300},
  tech: {firstYearYen: 480, renewalYearYen: 5980, restoreYen: 3300},
  space: {firstYearYen: 280, renewalYearYen: 2980, restoreYen: 3300},
  store: {firstYearYen: 280, renewalYearYen: 5980, restoreYen: 3300},
  website: {firstYearYen: 380, renewalYearYen: 3480, restoreYen: 3300},
  press: {firstYearYen: 980, renewalYearYen: 7980, restoreYen: 3300},
  host: {firstYearYen: 1280, renewalYearYen: 6980, restoreYen: 3300},
  fun: {firstYearYen: 280, renewalYearYen: 2980, restoreYen: 3300},
  icu: {firstYearYen: 98, renewalYearYen: 1280, restoreYen: 3300},
  cyou: {firstYearYen: 98, renewalYearYen: 1180, restoreYen: 3300},
  sbs: {firstYearYen: 198, renewalYearYen: 1780, restoreYen: 3300},
  bond: {firstYearYen: 480, renewalYearYen: 2480, restoreYen: 3300},
  cfd: {firstYearYen: 380, renewalYearYen: 2280, restoreYen: 3300},
  art: {firstYearYen: 780, renewalYearYen: 2480, restoreYen: 3300},
  build: {firstYearYen: 1480, renewalYearYen: 4980, restoreYen: 3300},
  ceo: {firstYearYen: 3980, renewalYearYen: 6980, restoreYen: 4400},
};

/**
 * Looks up the price row for a domain's TLD.
 *
 * @param {string} domainName Domain to price.
 * @return {TldPrice} Price row, or the default for an unknown TLD.
 */
function priceRow(domainName: string): TldPrice {
  return PRICE_TABLE_YEN[tldOf(domainName)] ?? DEFAULT_PRICE;
}

/**
 * Computes the charge for a registration: first year + renewal price for
 * every following year (same formula the confirm screen displays,
 * frontend/src/features/orders/orderFormModel.ts `totalPriceYen`).
 *
 * @param {string} domainName Domain being registered.
 * @param {number} periodYears Registration period.
 * @return {number} Amount in yen.
 */
export function priceForRegistration(
  domainName: string,
  periodYears: number,
): number {
  const row = priceRow(domainName);
  return row.firstYearYen +
    row.renewalYearYen * Math.max(0, periodYears - 1);
}

/**
 * Computes the charge for a renewal.
 *
 * @param {string} domainName Domain being renewed.
 * @param {number} periodYears Renewal period.
 * @return {number} Amount in yen.
 */
export function priceForRenewal(
  domainName: string,
  periodYears: number,
): number {
  return priceRow(domainName).renewalYearYen * periodYears;
}

/**
 * Restore fee shown before an RGP restore (FIG.4, spec 6.5).
 *
 * TBD #7, like the registration prices. Note that the pseudo-registry does no
 * billing of its own — this figure exists so the screen can warn that getting
 * a deleted domain back is not free, which is the whole reason the spec
 * rejects a "recycle bin" metaphor.
 *
 * @param {string} domainName Domain being restored.
 * @return {number} Amount in yen.
 */
export function priceForRestore(domainName: string): number {
  return priceRow(domainName).restoreYen;
}
