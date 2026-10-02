import { describe, expect, it } from 'vitest'
import { getTldPricing } from '../../domains/tldData'
import { orderPathForDomain } from './orderPath'

describe('orderPathForDomain', () => {
  it('returns the /domains/new link for a domain with a priced TLD', () => {
    expect(getTldPricing('.com')).toBeDefined()
    expect(orderPathForDomain('myshop.com')).toBe('/domains/new?domain=myshop.com')
  })

  it('lower-cases and trims like parseOrderableDomain does', () => {
    expect(orderPathForDomain('  MyShop.COM  ')).toBe('/domains/new?domain=myshop.com')
  })

  it('percent-encodes the domain in the query string', () => {
    // Not a realistic assistant-candidate label (labels are charset-validated
    // upstream), but proves the query param is actually encoded, not just
    // concatenated - relevant because this string reaches a URL.
    expect(orderPathForDomain('my shop.com')).toBe('/domains/new?domain=my%20shop.com')
  })

  it('returns null for an empty string', () => {
    expect(orderPathForDomain('')).toBeNull()
  })

  it('returns null for a domain with no dot', () => {
    expect(orderPathForDomain('myshop')).toBeNull()
  })

  it('returns null when the TLD has no pricing entry', () => {
    expect(getTldPricing('.example')).toBeUndefined()
    expect(orderPathForDomain('myshop.example')).toBeNull()
  })

  it('returns null for a javascript:-style string', () => {
    expect(orderPathForDomain('javascript:alert(1)')).toBeNull()
    expect(orderPathForDomain('javascript:alert(1);document.cookie')).toBeNull()
  })

  it('returns null when the label is empty (a domain starting with a dot)', () => {
    expect(orderPathForDomain('.com')).toBeNull()
  })

  it('returns null when the TLD is empty (a domain ending with a dot)', () => {
    expect(orderPathForDomain('myshop.')).toBeNull()
  })
})
