import { describe, expect, it } from 'vitest'
import { labelForDomainStatus } from './domainStatusLabels'

describe('domain status labels (spec §3.5)', () => {
  it('uses the spec-fixed beginner wording for ok and inactive', () => {
    expect(labelForDomainStatus('ok')).toEqual({ status: 'ok', label: '使えています', tone: 'ok' })
    expect(labelForDomainStatus('inactive')).toEqual({
      status: 'inactive',
      label: 'まだインターネットに公開されていません',
      tone: 'inactive',
    })
  })

  it('covers the lifecycle and lock statuses of the table', () => {
    expect(labelForDomainStatus('pendingDelete').label).toBe('解約手続き中です')
    // RGP: never shown as raw English next to 解約手続き中.
    expect(labelForDomainStatus('redemptionPeriod').label).toBe('いまなら復旧できます')
    expect(labelForDomainStatus('clientHold').label).toBe('一時停止中です')
    expect(labelForDomainStatus('clientTransferProhibited').label).toBe('引っ越しをロック中')
  })

  it('passes unknown statuses through verbatim instead of hiding them', () => {
    expect(labelForDomainStatus('serverHold')).toEqual({ status: 'serverHold', label: 'serverHold', tone: 'neutral' })
  })
})
