/**
 * The RGP display rules (§6.5, RFC 3915).
 *
 * Two things the screens must never do: offer 復旧 for a domain the registry
 * would refuse (2304), and print a negative countdown. Both are decided here,
 * so both are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { canRestore, daysLeftUntil, daysUntil } from './domainDisplay'

const NOW = new Date('2026-08-26T00:00:00Z')

describe('canRestore', () => {
  it('accepts redemptionPeriod in rgpStatuses', () => {
    expect(
      canRestore({ statuses: ['pendingDelete'], rgpStatuses: ['redemptionPeriod'] }, NOW),
    ).toBe(true)
  })

  it('accepts redemptionPeriod in statuses', () => {
    // The registries' prose puts it there; their schema puts it in rgpStatus.
    expect(
      canRestore({ statuses: ['pendingDelete', 'redemptionPeriod'], rgpStatuses: [] }, NOW),
    ).toBe(true)
  })

  it('refuses pendingDelete on its own: that is the non-restorable tail', () => {
    expect(canRestore({ statuses: ['pendingDelete'], rgpStatuses: [] }, NOW)).toBe(false)
  })

  it('refuses once the deadline has passed, even if the status lags behind', () => {
    expect(
      canRestore(
        {
          statuses: ['pendingDelete'],
          rgpStatuses: ['redemptionPeriod'],
          restorableUntil: '2026-08-25T00:00:00Z',
        },
        NOW,
      ),
    ).toBe(false)
  })

  it('accepts a deadline still ahead of us', () => {
    expect(
      canRestore(
        {
          statuses: ['pendingDelete'],
          rgpStatuses: ['redemptionPeriod'],
          restorableUntil: '2026-09-30T00:00:00Z',
        },
        NOW,
      ),
    ).toBe(true)
  })

  it('says no for a live domain', () => {
    expect(canRestore({ statuses: ['ok'], rgpStatuses: ['autoRenewPeriod'] }, NOW)).toBe(false)
  })
})

describe('daysUntil', () => {
  // Regression for the off-by-one report: exDate 2027-08-28 showed 残り366日
  // when viewed in the early morning. The count is a calendar-day difference
  // and must not depend on the viewing hour. (Local-time strings keep these
  // assertions timezone-agnostic.)
  it('counts calendar days, so the viewing hour never changes the answer', () => {
    const morning = new Date('2026-08-28T08:30:00')
    const night = new Date('2026-08-28T23:30:00')
    expect(daysUntil('2027-08-28T00:00:00', morning)).toBe(365)
    expect(daysUntil('2027-08-28T00:00:00', night)).toBe(365)
  })

  it('a date-only exDate answers the same at any hour (UTC-midnight parsing must not leak)', () => {
    const morning = new Date('2026-08-28T08:30:00')
    const night = new Date('2026-08-28T23:30:00')
    expect(daysUntil('2027-08-28', morning)).toBe(daysUntil('2027-08-28', night))
  })

  it('includes the leap day: two years over 2028 is 731 days, not 730 or 732', () => {
    expect(daysUntil('2028-08-28T12:00:00', new Date('2026-08-28T08:30:00'))).toBe(731)
  })

  it("handles the registry's timezone-less nanosecond format", () => {
    expect(
      daysUntil('2027-08-28T03:06:24.857268184', new Date('2026-08-28T08:30:00')),
    ).toBe(365)
  })
})

describe('daysLeftUntil', () => {
  it('counts the days that are left', () => {
    expect(daysLeftUntil('2026-09-05T00:00:00Z', NOW)).toBe(10)
  })

  it('clamps a passed deadline to 0 instead of printing あと-2日', () => {
    expect(daysUntil('2026-08-24T00:00:00Z', NOW)).toBe(-2)
    expect(daysLeftUntil('2026-08-24T00:00:00Z', NOW)).toBe(0)
  })
})
