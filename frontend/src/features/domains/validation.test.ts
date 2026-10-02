import { describe, expect, it } from 'vitest'
import { normalizeDomainLabel, validateDomainSearchForm } from './validation'

describe('normalizeDomainLabel', () => {
  it('folds full-width alphanumerics and hyphen to half-width', () => {
    expect(normalizeDomainLabel('ｍｙ－ｓｈｏｐ')).toBe('my-shop')
  })

  it('strips internal and surrounding whitespace, including the full-width space', () => {
    expect(normalizeDomainLabel('　my shop　')).toBe('myshop')
  })

  it('leaves an already-valid label untouched', () => {
    expect(normalizeDomainLabel('my-shop')).toBe('my-shop')
  })
})

describe('validateDomainSearchForm', () => {
  const validTlds = ['.com']

  it('accepts a valid label and at least one TLD', () => {
    expect(validateDomainSearchForm({ label: 'my-shop', tlds: validTlds })).toEqual({})
  })

  it('rejects an empty label', () => {
    const errors = validateDomainSearchForm({ label: '', tlds: validTlds })
    expect(errors.label).toBeDefined()
  })

  it('rejects a label containing a dot (must not include the TLD)', () => {
    const errors = validateDomainSearchForm({ label: 'example.com', tlds: validTlds })
    expect(errors.label).toMatch(/TLD/)
  })

  it('rejects a label longer than 63 characters (spec §3.4)', () => {
    const errors = validateDomainSearchForm({ label: 'a'.repeat(64), tlds: validTlds })
    expect(errors.label).toMatch(/63/)
  })

  it('rejects a label with a character outside alphanumeric/hyphen (spec §3.4)', () => {
    const errors = validateDomainSearchForm({ label: 'my_shop', tlds: validTlds })
    expect(errors.label).toBeDefined()
  })

  it('rejects a label starting with a hyphen (spec §3.4)', () => {
    const errors = validateDomainSearchForm({ label: '-myshop', tlds: validTlds })
    expect(errors.label).toMatch(/ハイフン/)
  })

  it('rejects a label ending with a hyphen (spec §3.4)', () => {
    const errors = validateDomainSearchForm({ label: 'myshop-', tlds: validTlds })
    expect(errors.label).toMatch(/ハイフン/)
  })

  it('rejects zero selected TLDs', () => {
    const errors = validateDomainSearchForm({ label: 'my-shop', tlds: [] })
    expect(errors.tlds).toBeDefined()
  })
})
