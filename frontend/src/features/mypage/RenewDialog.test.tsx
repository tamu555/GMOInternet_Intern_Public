/**
 * `RenewDialog` (FIG.10 RENEW): the dialog now owns the dummy-payment gate on
 * top of the existing 期間選択, so `onSubmit` must only fire once a valid
 * payment method is filled in.
 */
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenewDialog } from './RenewDialog'

afterEach(cleanup)

function Harness({ onSubmit }: { onSubmit: (years: number) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <RenewDialog
      open={open}
      onOpenChange={setOpen}
      domainName="myshop.com"
      exDate="2027-01-01"
      busy={false}
      onSubmit={onSubmit}
    />
  )
}

describe('RenewDialog: rendering', () => {
  it('renders the renewal summary and the payment section', async () => {
    render(<Harness onSubmit={vi.fn()} />)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '期限を更新する' })).toBeInTheDocument()
    expect(screen.getByText('お支払い方法')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'クレジットカード / デビットカード' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '支払って更新する' })).toBeInTheDocument()
  })
})

describe('RenewDialog: 決済手段の必須ゲート', () => {
  it('決済手段を選ばずに「支払って更新する」を押しても onSubmit を呼ばない', async () => {
    const onSubmit = vi.fn<(years: number) => void>()
    const user = userEvent.setup()
    render(<Harness onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: '支払って更新する' }))

    expect(await screen.findByText('お支払い方法を選択してください。')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('ダミー値を入力してから支払うと、選んだ年数で onSubmit を呼ぶ', async () => {
    const onSubmit = vi.fn<(years: number) => void>()
    const user = userEvent.setup()
    render(<Harness onSubmit={onSubmit} />)

    await user.selectOptions(screen.getByLabelText('更新期間'), '2')
    await user.click(screen.getByRole('radio', { name: 'クレジットカード / デビットカード' }))
    await user.click(screen.getByRole('button', { name: 'ダミー値を入力' }))
    await user.click(screen.getByRole('button', { name: '支払って更新する' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(2)
  })
})
