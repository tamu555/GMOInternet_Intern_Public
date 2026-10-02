import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThirdPartyLicensesPage } from './ThirdPartyLicensesPage'

// The page imports these repo-root legal/ files via Vite's `?raw` suffix.
// Mock them so the test asserts on the page's own rendering, not the
// (large, unrelated) license text content itself.
vi.mock('../../../legal/THIRD_PARTY_NOTICES.txt?raw', () => ({
  default: 'MOCK NOTICE BODY',
}))
vi.mock('../../../legal/WEBLLM_LICENSE.txt?raw', () => ({
  default: 'MOCK WEB-LLM LICENSE BODY',
}))
vi.mock('../../../legal/QWEN_LICENSE.txt?raw', () => ({
  default: 'MOCK QWEN LICENSE BODY',
}))

describe('ThirdPartyLicensesPage', () => {
  it('renders the title, all section headings, and the license bodies', () => {
    render(<ThirdPartyLicensesPage />)

    expect(screen.getByRole('heading', { level: 1, name: '第三者ライセンス' })).toBeInTheDocument()

    expect(screen.getByRole('heading', { level: 2, name: '概要' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: '@mlc-ai/web-llm（Apache License 2.0）' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Qwen（Apache License 2.0）' }),
    ).toBeInTheDocument()

    expect(screen.getByText('MOCK NOTICE BODY')).toBeInTheDocument()
    expect(screen.getByText('MOCK WEB-LLM LICENSE BODY')).toBeInTheDocument()
    expect(screen.getByText('MOCK QWEN LICENSE BODY')).toBeInTheDocument()
  })
})
