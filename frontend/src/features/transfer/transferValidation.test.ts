import { describe, expect, it } from 'vitest'
import {
  normalizeAuthInfo,
  normalizeTransferDomainName,
  validateAuthInfo,
  validateTransferDomainName,
  validateTransferInForm,
} from './transferValidation'

describe('normalizeTransferDomainName', () => {
  it('folds full-width input, strips whitespace and the trailing dot, lowercases', () => {
    expect(normalizeTransferDomainName('　Ｅｘａｍｐｌｅ．ｃｏｍ ')).toBe('example.com')
    expect(normalizeTransferDomainName('Example.COM.')).toBe('example.com')
    expect(normalizeTransferDomainName('exa mple.com')).toBe('example.com')
  })
})

describe('validateTransferDomainName (§3.4)', () => {
  it('accepts a normal FQDN', () => {
    expect(validateTransferDomainName('example.com')).toBeUndefined()
    expect(validateTransferDomainName('sub.example-shop.net')).toBeUndefined()
  })

  it('requires the TLD part (the search screen takes labels, this one does not)', () => {
    expect(validateTransferDomainName('example')).toMatch(/TLD/)
  })

  it('rejects empty input, bad characters and hyphen placement', () => {
    expect(validateTransferDomainName('')).toBeTruthy()
    expect(validateTransferDomainName('exam_ple.com')).toMatch(/英数字とハイフン/)
    expect(validateTransferDomainName('-example.com')).toMatch(/ハイフン/)
    expect(validateTransferDomainName('example-.com')).toMatch(/ハイフン/)
    expect(validateTransferDomainName('example..com')).toMatch(/ドット/)
  })

  it('rejects over-long labels (>63) and names (>253)', () => {
    expect(validateTransferDomainName(`${'a'.repeat(64)}.com`)).toMatch(/63文字/)
    const long = `${'a'.repeat(63)}.`.repeat(4) + 'com'
    expect(validateTransferDomainName(long)).toMatch(/253文字/)
  })
})

describe('validateAuthInfo (§3.4: 1〜64文字)', () => {
  it('accepts 1..64 chars and rejects empty / 65', () => {
    expect(validateAuthInfo('x')).toBeUndefined()
    expect(validateAuthInfo('x'.repeat(64))).toBeUndefined()
    expect(validateAuthInfo('')).toBeTruthy()
    expect(validateAuthInfo('x'.repeat(65))).toMatch(/64文字/)
  })

  it('normalizeAuthInfo trims copy-paste whitespace only', () => {
    expect(normalizeAuthInfo('  K9#code  ')).toBe('K9#code')
    expect(normalizeAuthInfo('K9 #code')).toBe('K9 #code')
  })
})

describe('validateTransferInForm', () => {
  it('reports both fields independently', () => {
    const errors = validateTransferInForm({ domainName: '', authInfo: '' })
    expect(errors.domainName).toBeTruthy()
    expect(errors.authInfo).toBeTruthy()
    expect(validateTransferInForm({ domainName: 'example.com', authInfo: 'code' })).toEqual({})
  })
})
