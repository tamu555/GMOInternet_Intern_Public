import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainCandidateList } from './DomainCandidateList'
import type { AssistantDomainCandidate, DomainSuggestionResult } from './suggest/domainSuggestion'

afterEach(cleanup)

function candidate(overrides: Partial<AssistantDomainCandidate> & Pick<AssistantDomainCandidate, 'domain' | 'tld'>): AssistantDomainCandidate {
  return {
    label: overrides.domain.split('.')[0]!,
    origin: 'rule',
    reason: null,
    firstYearYen: null,
    caveat: null,
    orderable: true,
    ...overrides,
  }
}

describe('DomainCandidateList', () => {
  it('renders nothing and shows no headings when both candidate lists are empty and not degraded', () => {
    const result: DomainSuggestionResult = { ruleCandidates: [], aiCandidates: [], degraded: false, seedLabel: 'shop', droppedUnorderableCount: 0 }
    const { container } = render(<DomainCandidateList result={result} onOrder={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the rule-based section before the AI section (DOM order)', () => {
    const result: DomainSuggestionResult = {
      ruleCandidates: [candidate({ domain: 'shop.com', tld: '.com', reason: '同じ文字列を .com で試せます' })],
      aiCandidates: [candidate({ domain: 'shopweb.com', tld: '.com', origin: 'ai' })],
      degraded: false,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={vi.fn()} />)

    const ruleHeading = screen.getByText('おすすめ候補')
    const aiHeading = screen.getByText('AI提案')
    // DOM order check: comparing document position tells us which renders first.
    expect(ruleHeading.compareDocumentPosition(aiHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders a caveat as an Alert', () => {
    const result: DomainSuggestionResult = {
      ruleCandidates: [
        candidate({ domain: 'shop.dev', tld: '.dev', caveat: 'HSTSプリロード済みのため、常時HTTPS化が必須です。' }),
      ],
      aiCandidates: [],
      degraded: false,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('HSTSプリロード済みのため、常時HTTPS化が必須です。')
  })

  it('renders no 申し込む button for a candidate with orderable: false', () => {
    const result: DomainSuggestionResult = {
      ruleCandidates: [candidate({ domain: 'shop.doesnotexist', tld: '.doesnotexist', orderable: false })],
      aiCandidates: [],
      degraded: false,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={vi.fn()} />)

    expect(screen.queryByRole('button', { name: '申し込む' })).not.toBeInTheDocument()
    expect(screen.getByText('このTLDは現在お申し込みいただけません。')).toBeInTheDocument()
  })

  it('calls onOrder with the /domains/new?domain=… path when 申し込む is clicked', async () => {
    const user = userEvent.setup()
    const onOrder = vi.fn()
    const result: DomainSuggestionResult = {
      ruleCandidates: [candidate({ domain: 'shop.com', tld: '.com', firstYearYen: 1580 })],
      aiCandidates: [],
      degraded: false,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={onOrder} />)

    await user.click(screen.getByRole('button', { name: '申し込む' }))

    expect(onOrder).toHaveBeenCalledWith('/domains/new?domain=shop.com')
  })

  it('shows the price via formatYen', () => {
    const result: DomainSuggestionResult = {
      ruleCandidates: [candidate({ domain: 'shop.com', tld: '.com', firstYearYen: 1580 })],
      aiCandidates: [],
      degraded: false,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={vi.fn()} />)

    expect(screen.getByText(/¥1,580/)).toBeInTheDocument()
  })

  it('renders only the honest failure copy and no candidates when degraded', () => {
    const result: DomainSuggestionResult = {
      ruleCandidates: [candidate({ domain: 'shop.com', tld: '.com' })],
      aiCandidates: [],
      degraded: true,
      seedLabel: 'shop', droppedUnorderableCount: 0,
    }
    render(<DomainCandidateList result={result} onOrder={vi.fn()} />)

    expect(screen.getByText('確認できませんでした')).toBeInTheDocument()
    expect(screen.getByText('候補の空き状況を確認できませんでした。ドメイン検索画面から確認してください。')).toBeInTheDocument()
    expect(screen.queryByText('shop.com')).not.toBeInTheDocument()
  })
})
