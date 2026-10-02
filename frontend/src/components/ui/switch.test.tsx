/**
 * スイッチの OFF が OFF に見えること。
 *
 * ⚠️ 2026-08-28 の回帰。OFF の溝は `bg-input`（＝ --line-strong ＝ --grass-3、
 * 実測 #cbe6c4）で塗られていた。若草の 3 階調はこのアプリでは「選ばれている・
 * 進んでいる」を表す塗り（現在地のチップ、選択中のナビ）なので、ON の溝
 * （#1f6d45）と並ぶと**どちらも緑**で、保護ロックを OFF にしているのに ON に
 * 見える、という指摘が出た。緑の階調から外した `--switch-off` を専用に持たせて
 * ある。
 *
 * ⚠️ ここだけはクラス名を見る。この修正で変えたのは**溝の色だけ**で、
 * `data-state` もつまみの位置も aria も一切変わっていない。role と状態だけで
 * 書いたテストは、色を戻しても通ってしまい回帰テストにならない
 * （同日、ProgressSteps の完了段の色が実際に静かに巻き戻された）。
 * 色そのものの見え方はスクリーンショットで確認する。ここが守るのは
 * 「若草の階調に戻されていないこと」の 1 点だけ。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Switch } from './switch'

function track(): HTMLElement {
  return screen.getByRole('switch')
}

describe('Switch', () => {
  it('OFF の溝は緑の階調（bg-input / --grass-*）で塗らない', () => {
    render(<Switch aria-label="移管ロック" checked={false} onCheckedChange={() => {}} />)

    expect(track()).toHaveAttribute('data-state', 'unchecked')
    expect(track().className).toContain('bg-switch-off')
    // bg-input は --line-strong ＝ --grass-3。ここに戻すと OFF が ON に見える。
    expect(track().className).not.toMatch(/\bbg-input\b/)
    expect(track().className).not.toMatch(/\bbg-grass-/)
  })

  it('ON の溝だけが primary で塗られる', () => {
    render(<Switch aria-label="移管ロック" checked onCheckedChange={() => {}} />)

    expect(track()).toHaveAttribute('data-state', 'checked')
    expect(track().className).toContain('data-[state=checked]:bg-primary')
  })

  it('つまみの位置でも状態が分かる（色だけに意味を持たせない）', () => {
    const { rerender } = render(<Switch aria-label="移管ロック" checked={false} onCheckedChange={() => {}} />)
    const thumbClass = () =>
      (track().querySelector('[data-slot="switch-thumb"]') as HTMLElement).className

    expect(thumbClass()).toContain('data-[state=unchecked]:translate-x-0.5')
    rerender(<Switch aria-label="移管ロック" checked onCheckedChange={() => {}} />)
    expect(thumbClass()).toContain('data-[state=checked]:translate-x-4')
  })
})
