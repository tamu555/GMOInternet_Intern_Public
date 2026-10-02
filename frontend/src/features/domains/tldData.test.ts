import { describe, expect, it } from 'vitest'
import { TLD_METADATA, TLD_PRICING, getTldPricing, getTldPricingOrDefault, threeYearTotalYen } from './tldData'

describe('tldData', () => {
  it('has a pricing row for every metadata entry and vice versa', () => {
    const metaTlds = new Set(TLD_METADATA.map((meta) => meta.tld))
    const pricingTlds = new Set(TLD_PRICING.map((pricing) => pricing.tld))
    expect(pricingTlds).toEqual(metaTlds)
  })

  it("locks Kitaqsign's confirmed TLDs to the spec §3.8 set " +
    '(2026-08-27 16:00 に .org / .info は Kitaqnic へ移管)', () => {
    const kitaqsignTlds = TLD_METADATA.filter((meta) => meta.registry === 'kitaqsign').map((meta) => meta.tld)
    expect(new Set(kitaqsignTlds)).toEqual(new Set(['.com', '.net']))
  })

  it("locks Kitaqnic's TLDs to the spec §3.8 set " +
    '(実測 2026-08-26 の18 + 2026-08-27 移管の .org / .info)', () => {
    const kitaqnicTlds = TLD_METADATA.filter((meta) => meta.registry === 'kitaqnic').map((meta) => meta.tld)
    expect(new Set(kitaqnicTlds)).toEqual(
      new Set([
        '.org', '.info',
        '.xyz', '.online', '.site', '.tech', '.space', '.store', '.website', '.press', '.host',
        '.fun', '.icu', '.cyou', '.sbs', '.bond', '.cfd', '.art', '.build', '.ceo',
      ]),
    )
  })

  it('computes the 3-year total as first year + two renewal years', () => {
    expect(threeYearTotalYen({ tld: '.test', firstYearYen: 1000, renewalYearYen: 2000, restoreYen: 0 })).toBe(5000)
  })

  it('answers the table price for a listed TLD from both lookups', () => {
    expect(getTldPricingOrDefault('.com')).toEqual(getTldPricing('.com'))
  })

  it('falls back to the server DEFAULT_PRICE for an unlisted TLD ' +
    '(functions/src/domain/pricing.ts must charge the same figures)', () => {
    expect(getTldPricing('.example')).toBeUndefined()
    expect(getTldPricingOrDefault('.example')).toEqual({
      tld: '.example',
      firstYearYen: 1500,
      renewalYearYen: 1500,
      restoreYen: 8000,
    })
  })
})
