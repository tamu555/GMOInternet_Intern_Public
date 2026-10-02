/**
 * The autoRenewPeriod badge (§3.6/§6.4): the countdown parenthetical must
 * appear exactly when the server-derived deadline is present. Regression for
 * the review finding 「自動更新取り消しまで◯◯日表示がフロントにだけある」 —
 * the deadline now comes from listDomains (functions/src/domain/
 * domainRepository.ts), and this pins the render contract on top of it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StatusBadges } from './StatusBadges'

afterEach(cleanup)

const DAY_MS = 24 * 60 * 60 * 1000

describe('StatusBadges', () => {
  it('shows the cancel countdown when the deadline is provided', () => {
    render(
      <StatusBadges
        statuses={['ok']}
        rgpStatuses={['autoRenewPeriod']}
        autoRenewCancelableUntil={new Date(Date.now() + 10 * DAY_MS).toISOString()}
      />,
    )

    expect(screen.getByText(/自動で1年延びました（取り消すなら残り10日）/)).toBeInTheDocument()
  })

  it('keeps the badge but drops the countdown when no deadline is known', () => {
    // Older mirrors (or a backend that could not derive the deadline) send
    // nothing; the badge itself must still appear, without a bogus number.
    render(<StatusBadges statuses={['ok']} rgpStatuses={['autoRenewPeriod']} />)

    expect(screen.getByText('自動で1年延びました')).toBeInTheDocument()
    expect(screen.queryByText(/取り消すなら残り/)).not.toBeInTheDocument()
  })

  it('renders no auto-renew badge outside the window', () => {
    render(
      <StatusBadges
        statuses={['ok']}
        rgpStatuses={[]}
        autoRenewCancelableUntil={new Date(Date.now() + 10 * DAY_MS).toISOString()}
      />,
    )

    expect(screen.queryByText(/自動で1年延びました/)).not.toBeInTheDocument()
  })
})
