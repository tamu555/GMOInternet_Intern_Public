import { describe, expect, it } from 'vitest'
import { generateAuthInfo, ORDER_FORM_DEFAULTS } from './orderDefaults'

describe('§6.2.6 defaults (TBD #5 placeholders)', () => {
  it('follows the spec proposal column: 1 year, auto-renew ON, member contact', () => {
    expect(ORDER_FORM_DEFAULTS.registrationYears).toBe(1)
    expect(ORDER_FORM_DEFAULTS.autoRenew).toBe(true)
    expect(ORDER_FORM_DEFAULTS.registrantSource).toBe('member-contact')
    expect(ORDER_FORM_DEFAULTS.adminTechBillingSameAsRegistrant).toBe(true)
  })

  it('ships NO default nameserver: a purchase never depends on a DNS we do not run', () => {
    expect(ORDER_FORM_DEFAULTS.nameserverMode).toBe('none')
    expect(ORDER_FORM_DEFAULTS).not.toHaveProperty('defaultNameservers')
  })
})

describe('generateAuthInfo (spec §6.2.6 自動生成 / §3.4 1〜64文字)', () => {
  it('generates 20+ chars by default while staying within the 64-char registry limit', () => {
    const authInfo = generateAuthInfo()
    expect(authInfo.length).toBeGreaterThanOrEqual(20)
    expect(authInfo.length).toBeLessThanOrEqual(64)
  })

  it('uses only alphanumerics and passphrase-safe symbols', () => {
    expect(generateAuthInfo(64)).toMatch(/^[A-Za-z0-9!#$%*+\-=_]+$/)
  })

  it('does not repeat itself', () => {
    expect(generateAuthInfo()).not.toBe(generateAuthInfo())
  })
})
