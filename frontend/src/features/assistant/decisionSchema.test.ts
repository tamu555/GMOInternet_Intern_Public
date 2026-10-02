import { describe, expect, it } from 'vitest'
import { decisionSchema, validateDecision } from './decisionSchema'

const VALID_DECISION = {
  intent: 'CONNECT_WEBSITE',
  reply: 'DNS設定のレコード設定モードから接続できます。',
  routeId: 'DNS_RECORDS',
  slots: { provider: 'vercel' },
  confidence: 0.9,
  needsClarification: false,
}

describe('decisionSchema', () => {
  it('accepts a valid decision', () => {
    expect(validateDecision(VALID_DECISION)).toEqual(VALID_DECISION)
    expect(decisionSchema.safeParse(VALID_DECISION).success).toBe(true)
  })

  it('rejects an unknown intent', () => {
    expect(validateDecision({ ...VALID_DECISION, intent: 'DELETE_EVERYTHING' })).toBeNull()
  })

  it('rejects an unknown routeId', () => {
    expect(validateDecision({ ...VALID_DECISION, routeId: 'NOT_A_ROUTE' })).toBeNull()
  })

  it('rejects a disabled routeId', () => {
    // EASY_MODE exists in the Manifest but enabled: false - not selectable.
    expect(validateDecision({ ...VALID_DECISION, routeId: 'EASY_MODE' })).toBeNull()
  })

  it('rejects a reply longer than 1000 characters', () => {
    expect(validateDecision({ ...VALID_DECISION, reply: 'a'.repeat(1001) })).toBeNull()
  })

  it('accepts a reply exactly at the 1000 character limit', () => {
    expect(validateDecision({ ...VALID_DECISION, reply: 'a'.repeat(1000) })).not.toBeNull()
  })

  it('rejects a confidence value out of the 0-1 range', () => {
    expect(validateDecision({ ...VALID_DECISION, confidence: 1.5 })).toBeNull()
    expect(validateDecision({ ...VALID_DECISION, confidence: -0.1 })).toBeNull()
  })

  it('rejects a non-boolean needsClarification', () => {
    expect(validateDecision({ ...VALID_DECISION, needsClarification: 'no' })).toBeNull()
  })
})
