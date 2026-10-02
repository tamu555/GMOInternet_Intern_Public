import { describe, expect, it } from 'vitest'
import { ORDER_FORM_DEFAULTS } from './orderDefaults'
import {
  buildInitialOrderFormValues,
  buildOrderCreateRequest,
  parseOrderableDomain,
  totalPriceYen,
  validateOrderForm,
  type OrderFormValues,
} from './orderFormModel'

function values(overrides: Partial<OrderFormValues> = {}): OrderFormValues {
  return { ...buildInitialOrderFormValues(), ...overrides }
}

describe('buildInitialOrderFormValues (spec §6.2.6 pre-fill)', () => {
  it('starts from the defaults with a freshly generated authInfo', () => {
    const initial = buildInitialOrderFormValues()
    expect(initial.years).toBe(ORDER_FORM_DEFAULTS.registrationYears)
    expect(initial.autoRenew).toBe(ORDER_FORM_DEFAULTS.autoRenew)
    expect(initial.nameserverMode).toBe('none')
    expect(initial.contactsSameAsRegistrant).toBe(true)
    expect(initial.authInfo.length).toBeGreaterThanOrEqual(20)
  })
})

describe('validateOrderForm (spec §3.4)', () => {
  it('accepts the untouched defaults', () => {
    expect(validateOrderForm(values())).toEqual({})
  })

  it('rejects an empty or over-long authInfo (1〜64文字)', () => {
    expect(validateOrderForm(values({ authInfo: '' })).authInfo).toBeDefined()
    expect(validateOrderForm(values({ authInfo: 'x'.repeat(65) })).authInfo).toBeDefined()
    expect(validateOrderForm(values({ authInfo: 'x' })).authInfo).toBeUndefined()
    expect(validateOrderForm(values({ authInfo: 'x'.repeat(64) })).authInfo).toBeUndefined()
  })

  it('requires at least one well-formed hostname when custom nameservers are chosen', () => {
    expect(
      validateOrderForm(values({ nameserverMode: 'custom', customNameservers: ['', ''] })).customNameservers,
    ).toBeDefined()
    expect(
      validateOrderForm(values({ nameserverMode: 'custom', customNameservers: ['not a host', ''] })).customNameservers,
    ).toBeDefined()
    expect(
      validateOrderForm(values({ nameserverMode: 'custom', customNameservers: ['ns1.example.com', ''] }))
        .customNameservers,
    ).toBeUndefined()
  })

  it('ignores custom nameserver contents while no nameserver is requested', () => {
    expect(validateOrderForm(values({ nameserverMode: 'none', customNameservers: ['garbage', ''] }))).toEqual({})
  })
})

describe('buildOrderCreateRequest (spec §1.2: the payload is always complete)', () => {
  it('requests no nameserver by default and fills every contact role', () => {
    const request = buildOrderCreateRequest('myshop.com', values())
    expect(request.domainName).toBe('myshop.com')
    expect(request.nameserverMode).toBe('none')
    expect(request.nameservers).toEqual([])
    expect(request.authInfo.length).toBeGreaterThan(0)
    expect(request.contacts).toEqual({
      registrant: 'member-contact',
      admin: 'member-contact',
      tech: 'member-contact',
      billing: 'member-contact',
    })
  })

  it('trims and drops empty custom nameserver rows', () => {
    const request = buildOrderCreateRequest(
      'myshop.com',
      values({ nameserverMode: 'custom', customNameservers: [' ns1.example.com ', ''] }),
    )
    expect(request.nameservers).toEqual(['ns1.example.com'])
  })
})

describe('totalPriceYen (§6.2.5 初年度 + 更新料 × (n-1))', () => {
  const pricing = { tld: '.com', firstYearYen: 1000, renewalYearYen: 2000, restoreYen: 0 }

  it('charges only the first year for a 1-year order', () => {
    expect(totalPriceYen(pricing, 1)).toBe(1000)
  })

  it('adds renewal years beyond the first', () => {
    expect(totalPriceYen(pricing, 3)).toBe(5000)
  })
})

describe('parseOrderableDomain', () => {
  it('splits label and TLD and resolves pricing', () => {
    const parsed = parseOrderableDomain('myshop.com')
    expect(parsed?.label).toBe('myshop')
    expect(parsed?.tld).toBe('.com')
    expect(parsed?.pricing.firstYearYen).toBeGreaterThan(0)
  })

  it('rejects missing and undecomposable domains', () => {
    expect(parseOrderableDomain(null)).toBeNull()
    expect(parseOrderableDomain('')).toBeNull()
    expect(parseOrderableDomain('nodot')).toBeNull()
    expect(parseOrderableDomain('.com')).toBeNull()
  })

  it('accepts a TLD outside the price table at the server default price', () => {
    // The live registry TLD list can outgrow the local table; such a domain
    // must reach the form quoting what the backend will actually charge
    // (functions/src/domain/pricing.ts DEFAULT_PRICE), not bounce to search.
    const parsed = parseOrderableDomain('myshop.unlisted')
    expect(parsed?.tld).toBe('.unlisted')
    expect(parsed?.pricing.firstYearYen).toBe(1500)
    expect(parsed?.pricing.renewalYearYen).toBe(1500)
  })
})
