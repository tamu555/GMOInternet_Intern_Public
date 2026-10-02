/**
 * パスワード可視化ボタンの往復のリグレッションテスト。
 *
 * 2026-08-27 の報告「可視化ボタンが不可逆的」に対する固定。会員登録の2欄が
 * そもそも素の <input type="password"> で切り替えを持っていなかったのが実体
 * だったが、共通化した `PasswordInput` が片道になっていないことも、ここで
 * 押すたびに検証する。
 *
 * 見ているのは4つ全部が揃って反転すること: 入力欄の type、アイコン、
 * aria-label、aria-pressed。どれか1つでも固まると「戻せない」ボタンになる。
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordField, PasswordInput } from './PasswordField'

afterEach(cleanup)

/** 表示状態を1つのオブジェクトに畳んで、往復をそのまま比較できるようにする。 */
function readState(field: HTMLElement) {
  const input = field.querySelector('input') as HTMLInputElement
  const toggle = field.querySelector('button') as HTMLButtonElement
  return {
    type: input.type,
    label: toggle.getAttribute('aria-label'),
    pressed: toggle.getAttribute('aria-pressed'),
  }
}

const HIDDEN = { type: 'password', label: 'パスワードを表示', pressed: 'false' }
const SHOWN = { type: 'text', label: 'パスワードを隠す', pressed: 'true' }

describe('PasswordInput', () => {
  it('押すたびに表示と非表示を往復する', async () => {
    const user = userEvent.setup()
    const { container } = render(<PasswordInput autoComplete="new-password" defaultValue="hunter2" />)
    const field = container.firstElementChild as HTMLElement
    const toggle = screen.getByRole('button')

    expect(readState(field)).toEqual(HIDDEN)

    // 3回押す = 表示 → 非表示 → 表示。2回目で必ず初期状態へ戻ること。
    await user.click(toggle)
    expect(readState(field)).toEqual(SHOWN)
    await user.click(toggle)
    expect(readState(field)).toEqual(HIDDEN)
    await user.click(toggle)
    expect(readState(field)).toEqual(SHOWN)
  })

  it('呼び出し側が type="password" を渡しても切り替えを固定しない', async () => {
    const user = userEvent.setup()
    const { container } = render(<PasswordInput type="password" autoComplete="new-password" />)
    const field = container.firstElementChild as HTMLElement

    await user.click(screen.getByRole('button'))
    expect(readState(field)).toEqual(SHOWN)
  })

  it('切り替えても入力値は保たれ、フォーム送信は起きない', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput autoComplete="current-password" defaultValue="hunter2-secret" />
      </form>,
    )
    const input = screen.getByDisplayValue('hunter2-secret')

    await user.click(screen.getByRole('button'))
    expect(input).toHaveValue('hunter2-secret')
    // トグルは type="button"。ここが抜けると押すたびにフォームが飛ぶ。
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('無効化されているときは切り替えられない', async () => {
    const user = userEvent.setup()
    const { container } = render(<PasswordInput autoComplete="current-password" disabled />)
    const field = container.firstElementChild as HTMLElement

    await user.click(screen.getByRole('button'))
    expect(readState(field)).toEqual(HIDDEN)
  })
})

describe('PasswordField', () => {
  it('ラベル付きで組んでも往復する', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <PasswordField idPrefix="t" value="hunter2" onChange={() => {}} autoComplete="current-password" />,
    )
    const field = container.querySelector('.relative') as HTMLElement

    expect(readState(field)).toEqual(HIDDEN)
    await user.click(screen.getByRole('button'))
    expect(readState(field)).toEqual(SHOWN)
    await user.click(screen.getByRole('button'))
    expect(readState(field)).toEqual(HIDDEN)
  })

  it('エラーの説明先が入力欄に繋がったままになる', async () => {
    const user = userEvent.setup()
    render(
      <PasswordField
        idPrefix="t"
        value=""
        onChange={() => {}}
        error="8文字以上で入力してください"
        autoComplete="new-password"
      />,
    )
    const input = screen.getByLabelText('パスワード')

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain('t-password-error')

    // 表示に切り替えても aria の配線は変わらない（type だけが変わる）。
    await user.click(screen.getByRole('button', { name: 'パスワードを表示' }))
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain('t-password-error')
  })
})
