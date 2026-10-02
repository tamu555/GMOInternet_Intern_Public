/**
 * 進行状況の 3 状態（完了 / 現在地 / 未到達）の契約。見た目のクラス名ではなく、
 * 「何が描かれているか」だけを見る - 完了段は番号の代わりにチェックへ差し替わり、
 * 現在地だけが aria-current="step" を持つ。
 *
 * ⚠️ 完了段が薄すぎて未到達と見分けがつかない、という指摘から塗りを強めた回の
 * 回帰テスト。色の濃さはここでは測れないが、「完了は数字を出さない」という
 * 色に依らない区別だけは、どんな配色に変えても残す。
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProgressSteps } from './ProgressSteps'

const STEPS = [
  { id: 'a', label: '入力' },
  { id: 'b', label: '確認' },
  { id: 'c', label: '支払い' },
  { id: 'd', label: '完了' },
] as const

/**
 * その段が番号ではなくチェックを描いているか。
 * ⚠️ `querySelector('svg')` では引かない — その段に将来どんな装飾アイコンが
 * 入っても「完了」と読めてしまう。lucide がクラス名に出す図形名で引く。
 */
function hasCheckMark(item: HTMLElement): boolean {
  return item.querySelector('svg.lucide-check') !== null
}

/**
 * 完了段の四角の class 文字列。
 *
 * ⚠️ ふつうテストで class を見るのは避けるが、この 1 つだけは例外にしている。
 * 2026-08-28 の修正は「完了段が薄すぎて完了に見えない」という指摘への対応で、
 * 変えたのは **色の濃さだけ**（`bg-primary/15` → `bg-primary`）。チェックの
 * 有無も aria も変わっていないので、role とテキストだけで書いたテストは
 * 修正を戻しても全部通ってしまい、回帰テストとして機能しない。
 * 見た目そのものはスクリーンショットで確認する。ここが守るのは
 * 「半透明に戻されていないこと」という 1 点だけ。
 */
function chipClassOf(item: HTMLElement): string {
  const chip = item.querySelector('[aria-hidden="true"]:not(svg)')
  return chip?.className ?? ''
}

describe('ProgressSteps', () => {
  it('4 段の 3 段目にいるとき、済んだ 2 段はチェックに、現在地だけが aria-current を持つ', () => {
    render(<ProgressSteps steps={STEPS} currentIndex={2} label="お申し込みの進行状況" />)

    const items = within(screen.getByRole('navigation', { name: 'お申し込みの進行状況' })).getAllByRole('listitem')
    expect(items).toHaveLength(4)

    // 完了した 2 段: 番号は消えてチェックだけ。
    expect(hasCheckMark(items[0])).toBe(true)
    expect(hasCheckMark(items[1])).toBe(true)
    expect(within(items[0]).queryByText('1')).toBeNull()
    expect(within(items[1]).queryByText('2')).toBeNull()

    // 現在地と未到達: 番号のまま。
    expect(hasCheckMark(items[2])).toBe(false)
    expect(hasCheckMark(items[3])).toBe(false)
    expect(within(items[2]).getByText('3')).toBeInTheDocument()
    expect(within(items[3]).getByText('4')).toBeInTheDocument()

    // aria-current は現在地の 1 つだけ。
    const current = screen.getByText('支払い').closest('[aria-current="step"]')
    expect(current).not.toBeNull()
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1)

    // ラベルは（狭い画面では視覚的に畳まれても）読み上げには常に出す。
    for (const step of STEPS) expect(screen.getByText(step.label)).toBeInTheDocument()
  })

  it('currentIndex に steps.length を渡すと全段が完了になり、aria-current は消える', () => {
    render(<ProgressSteps steps={STEPS} currentIndex={STEPS.length} label="お申し込みの進行状況" />)

    const items = screen.getAllByRole('listitem')
    for (const item of items) expect(hasCheckMark(item)).toBe(true)
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(0)
  })
})

describe('完了段の塗り', () => {
  it('完了段はベタ塗り（半透明の primary に戻っていない）', () => {
    render(<ProgressSteps steps={STEPS} currentIndex={2} label="テストの進行状況" />)
    const items = screen.getAllByRole('listitem')

    const done = chipClassOf(items[0])
    expect(done).toContain('bg-primary')
    // `bg-primary/15` のような不透明度つきに戻したら落ちる。
    expect(done).not.toMatch(/bg-primary\//)
  })
})

describe('7 段が 1 行に収まる前提の寸法', () => {
  /**
   * ⚠️ ここも `chipClassOf` と同じ「class を見る」例外。jsdom はレイアウトを持たない
   * （幅はすべて 0）ので、「折り返したか」はテストでは測れない。実測は実ブラウザで
   * 行い（ProgressSteps.tsx の JSDoc に 375/640/768/1280 の数値がある）、ここは
   * **その実測を無効にする書き換えだけ**を止める。
   *
   * かんたんモードの 7 段は 640px 幅で 565.57px 必要 / 使えるのは 584px ＝ 余り 18.43px。
   * 下の 2 つはどちらも 20px 以上を食うので、戻すと即 2 行になる。
   */
  const LABEL_TEXT = '入力'

  it('ラベルの文字サイズを sm 以上で大きくしない（`sm:text-sm` は 640px 幅で約 19px 超過する）', () => {
    render(<ProgressSteps steps={STEPS} currentIndex={2} label="テストの進行状況" />)

    const label = screen.getByText(LABEL_TEXT)
    expect(label.className).toContain('text-[13px]')
    // `sm:text-sm` / `md:text-base` のようなブレークポイント付きの拡大を禁じる。
    expect(label.className).not.toMatch(/\b(sm|md|lg|xl):text-(sm|base|lg)\b/)
  })

  it('連結線を md 未満で太くしない（線 1 本 +16px × 6 本 = 96px で 640px 幅が破れる）', () => {
    render(<ProgressSteps steps={STEPS} currentIndex={2} label="テストの進行状況" />)

    // 2 段目以降の先頭の子が連結線。1 段目には無い。
    const items = screen.getAllByRole('listitem')
    const connector = items[1].firstElementChild
    expect(connector).not.toBeNull()
    expect(connector?.className).toContain('w-2')
    // 24px（w-6）へ戻してよいのは器が広がりきる md 以上だけ。
    expect(connector?.className).not.toMatch(/(^|\s)(w-[3-9]|w-1[0-9])(\s|$)/)
    expect(connector?.className).not.toMatch(/\bsm:w-[3-9]\b/)
  })
})
