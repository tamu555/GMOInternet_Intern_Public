/**
 * トップページ下部の機能紹介。ここで守っているのは3つ。
 *
 * 1. 3つの節が、実物の語彙（ステップ名・レコードの言い換え・テンプレート数）
 *    から組まれている — トップページだけが古い説明を言い続けないため
 * 2. かんたんモードの入口が /easy を指している
 * 3. 見本には必ず「※ 表示は見本です」が付く（結果見本の節と同じ約束）
 *
 * AI の節が `assistantEnabled()` で丸ごと消えることは、そこだけモックして確かめる。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DNS_RECIPES } from '../dns/recipes'
import { EASY_STEPS } from '../easy/easyTypes'
import { LandingFeatures } from './LandingFeatures'

const { assistantEnabledMock } = vi.hoisted(() => ({ assistantEnabledMock: vi.fn(() => true) }))
vi.mock('../assistant/config/assistantConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistant/config/assistantConfig')>()),
  assistantEnabled: assistantEnabledMock,
}))

function renderFeatures() {
  return render(
    <MemoryRouter>
      <LandingFeatures />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  assistantEnabledMock.mockReturnValue(true)
})

describe('LandingFeatures', () => {
  it('introduces the three things that happen after the search', () => {
    renderFeatures()

    expect(screen.getByRole('heading', { name: '質問に答えるだけで、取得まで進めます' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'わからないことは、その場で聞けます' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'DNSの設定は、選ぶか貼るかで終わります' })).toBeInTheDocument()
  })

  it('sends かんたんモード to the wizard', () => {
    renderFeatures()

    expect(screen.getByRole('link', { name: /かんたんモードを試す/ })).toHaveAttribute('href', '/easy')
  })

  it('draws the step list from EASY_STEPS instead of its own copy', () => {
    renderFeatures()

    expect(screen.getByText(`ぜんぶで${EASY_STEPS.length}ステップ`)).toBeInTheDocument()
    for (const step of EASY_STEPS) {
      expect(screen.getByText(step.label)).toBeInTheDocument()
    }
    // ログインの境目は EASY_STEPS の requiresAuth から出す（4番目の「確認」）。
    const firstGuarded = EASY_STEPS.findIndex((step) => step.requiresAuth)
    expect(
      screen.getByText(
        new RegExp(`ログインが必要になるのは${firstGuarded + 1}番目の「${EASY_STEPS[firstGuarded].label}」から`),
      ),
    ).toBeInTheDocument()
  })

  it('counts the DNS templates instead of hardcoding the number', () => {
    renderFeatures()

    expect(screen.getByText(new RegExp(`テンプレートは${DNS_RECIPES.length}種類`))).toBeInTheDocument()
  })

  it('marks every mock as a mock', () => {
    renderFeatures()

    expect(screen.getAllByText(/※ 表示は見本です/)).toHaveLength(3)
  })

  it('never prints a record value in the つなぐ mock - only the plain-Japanese label', () => {
    renderFeatures()

    const preview = screen.getByText('作成されるレコード案').parentElement as HTMLElement
    expect(within(preview).getByText('サイトの置き場所（Aレコード）')).toBeInTheDocument()
    // レシピの値は '{key}' のプレースホルダを含みうるので、見本には出さない。
    expect(preview.textContent).not.toMatch(/\{|\d+\.\d+\.\d+\.\d+/)
  })

  it('drops the whole AI block when the assistant kill switch is off', () => {
    assistantEnabledMock.mockReturnValue(false)
    renderFeatures()

    expect(screen.queryByRole('heading', { name: 'わからないことは、その場で聞けます' })).not.toBeInTheDocument()
    // 残りの2つは残る。
    expect(screen.getByRole('heading', { name: '質問に答えるだけで、取得まで進めます' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'DNSの設定は、選ぶか貼るかで終わります' })).toBeInTheDocument()
  })
})
