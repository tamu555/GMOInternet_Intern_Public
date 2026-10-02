/**
 * The dev panel's registry 503-injection section
 * (docs/仕様/registry-unavailable.md §3): the switches must drive the real
 * `devForceRegistry503` callable — MSW plays no part in this section.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/callable', async () => {
  const { fakeInvoke } = await import('../test/fakeBackend')
  return { invoke: fakeInvoke }
})

import { fakeBackend } from '../test/fakeBackend'
import { MockControlPanel } from './MockControlPanel'

beforeEach(() => {
  fakeBackend.reset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MockControlPanel: レジストリ障害シミュレーション', () => {
  it('toggles a registry 503 flag through the dev callable', async () => {
    const user = userEvent.setup()
    render(<MockControlPanel />)

    await user.click(screen.getByRole('button', { name: /モックAPI設定/ }))
    const toggle = await screen.findByRole('checkbox', {
      name: 'kitaqnic への通信を503にする',
    })

    await user.click(toggle)
    expect(fakeBackend.force503()).toEqual({ kitaqsign: false, kitaqnic: true })

    await user.click(toggle)
    expect(fakeBackend.force503()).toEqual({ kitaqsign: false, kitaqnic: false })
    // The other registry's switch was never touched.
    expect(
      screen.getByRole('checkbox', { name: 'kitaqsign への通信を503にする' }),
    ).not.toBeChecked()
  })

  it('shows the auto-off time while a 503 flag is on', async () => {
    const user = userEvent.setup()
    render(<MockControlPanel />)

    await user.click(screen.getByRole('button', { name: /モックAPI設定/ }))
    const toggle = await screen.findByRole('checkbox', {
      name: 'kitaqnic への通信を503にする',
    })

    await user.click(toggle)
    // The status badge carries the concrete time; the hint text does not.
    expect(await screen.findByText(/〜\d{1,2}:\d{2} 自動OFF/)).toBeInTheDocument()
  })
})

describe('MockControlPanel: メンテナンス告知シミュレーション', () => {
  it('opens and clears a maintenance window through the dev callable', async () => {
    const user = userEvent.setup()
    render(<MockControlPanel />)

    await user.click(screen.getByRole('button', { name: /モックAPI設定/ }))
    const start = await screen.findByRole('button', {
      name: 'kitaqnic のメンテナンス窓を開始',
    })

    await user.click(start)
    expect(fakeBackend.devMaintenance()).toEqual({ kitaqsign: false, kitaqnic: true })
    // The status badge shows the window end; the hint text has no「（〜」.
    expect(await screen.findByText(/メンテナンス中（〜/)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'kitaqnic のメンテナンス窓を解除' }),
    )
    expect(fakeBackend.devMaintenance()).toEqual({ kitaqsign: false, kitaqnic: false })
    // The other registry's window was never touched.
    expect(
      screen.getByRole('button', { name: 'kitaqsign のメンテナンス窓を開始' }),
    ).toBeInTheDocument()
  })
})
