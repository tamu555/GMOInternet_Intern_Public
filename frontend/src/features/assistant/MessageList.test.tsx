import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from './MessageList'
import type { AssistantAction } from './actions'
import type { DomainSuggestionResult } from './suggest/domainSuggestion'
import type { ChatMessage, WalkthroughState } from './types'
import { findWalkthroughTemplate } from './walkthrough/walkthroughTemplates'

afterEach(cleanup)

function makeMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage {
  return { createdAt: 0, status: 'done', ...overrides }
}

describe('MessageList', () => {
  it('renders user and assistant text as plain text', () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: 'm1', role: 'user', content: 'Vercelにつなぎたい' }),
      makeMessage({ id: 'm2', role: 'assistant', content: 'ではDNS設定から……' }),
    ]

    render(<MessageList messages={messages} onNavigate={vi.fn()} />)

    expect(screen.getByText('Vercelにつなぎたい')).toBeInTheDocument()
    expect(screen.getByText('ではDNS設定から……')).toBeInTheDocument()
  })

  it('renders an XSS-style payload as literal text and creates no img element', () => {
    const payload = '<img src=x onerror=alert(1)>'
    const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: payload })]

    render(<MessageList messages={messages} onNavigate={vi.fn()} />)

    expect(screen.getByText(payload)).toBeInTheDocument()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('renders a NavigationCard when a message carries a navigation suggestion', () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: 'm1',
        role: 'assistant',
        content: 'DNS設定画面から操作できます。',
        navigation: {
          routeId: 'DNS_RECORDS',
          resolvedPath: '/domains/example.com/dns?mode=records',
          title: 'DNS設定（レコード設定モード）',
          description: 'DNSレコードの確認・変更ができます。',
        },
      }),
    ]

    render(<MessageList messages={messages} onNavigate={vi.fn()} />)

    expect(screen.getByText('DNS設定（レコード設定モード）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'DNS設定（レコード設定モード）へ進む' })).toBeInTheDocument()
  })

  it('calls onNavigate with the navigation suggestion when the card CTA is clicked', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    const navigation = {
      routeId: 'DNS_RECORDS' as const,
      resolvedPath: '/domains/example.com/dns?mode=records',
      title: 'DNS設定（レコード設定モード）',
      description: 'DNSレコードの確認・変更ができます。',
    }
    const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: '案内します。', navigation })]

    render(<MessageList messages={messages} onNavigate={onNavigate} />)
    await user.click(screen.getByRole('button', { name: 'DNS設定（レコード設定モード）へ進む' }))

    expect(onNavigate).toHaveBeenCalledWith(navigation)
  })

  it('shows the pending hint for a pending message', () => {
    const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'user', content: '質問です', status: 'pending' })]

    render(<MessageList messages={messages} onNavigate={vi.fn()} />)

    expect(screen.getByText('順番待ちです。モデルの準備が完了すると自動で送信します。')).toBeInTheDocument()
  })

  it('shows the failed hint for a failed message', () => {
    const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: '', status: 'failed' })]

    render(<MessageList messages={messages} onNavigate={vi.fn()} />)

    expect(screen.getByText('送信に失敗しました。')).toBeInTheDocument()
  })

  it('shows the empty-conversation hint when there are no messages', () => {
    render(<MessageList messages={[]} onNavigate={vi.fn()} />)

    expect(screen.getByText('まだメッセージはありません。下の入力欄から質問してみましょう。')).toBeInTheDocument()
  })

  describe('v1.4 Quick Actions', () => {
    const SET_SLOT_ACTION: AssistantAction = {
      kind: 'SET_SLOT',
      id: 'set-slot-provider-vercel',
      label: 'Vercel',
      payload: { slotKey: 'provider', value: 'vercel' },
    }

    it('renders message.actions via QuickActions beneath the message', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm1', role: 'assistant', content: 'どのサービスですか？', actions: [SET_SLOT_ACTION] }),
      ]

      render(<MessageList messages={messages} onNavigate={vi.fn()} onRunAction={vi.fn()} />)

      expect(screen.getByRole('button', { name: 'Vercel' })).toBeInTheDocument()
    })

    it('calls onRunAction with the clicked action', async () => {
      const user = userEvent.setup()
      const onRunAction = vi.fn()
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm1', role: 'assistant', content: 'どのサービスですか？', actions: [SET_SLOT_ACTION] }),
      ]

      render(<MessageList messages={messages} onNavigate={vi.fn()} onRunAction={onRunAction} />)
      await user.click(screen.getByRole('button', { name: 'Vercel' }))

      expect(onRunAction).toHaveBeenCalledWith(SET_SLOT_ACTION)
    })

    it('renders no Quick Actions when a message has no actions', () => {
      const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: '案内します。' })]

      render(<MessageList messages={messages} onNavigate={vi.fn()} onRunAction={vi.fn()} />)

      expect(screen.queryByRole('button', { name: 'Vercel' })).not.toBeInTheDocument()
    })
  })

  describe('v1.4 domain candidate list', () => {
    it('renders the candidate list beneath the message the suggestion is paired with, via messageId', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm1', role: 'assistant', content: 'ドメインの候補をご案内します。' }),
      ]
      const result: DomainSuggestionResult = {
        ruleCandidates: [
          {
            domain: 'shop.com',
            label: 'shop',
            tld: '.com',
            origin: 'rule',
            reason: null,
            firstYearYen: 1480,
            caveat: null,
            orderable: true,
          },
        ],
        aiCandidates: [],
        degraded: false,
        seedLabel: 'shop', droppedUnorderableCount: 0,
      }

      render(
        <MessageList
          messages={messages}
          onNavigate={vi.fn()}
          suggestion={{ status: 'done', result, messageId: 'm1' }}
          onOrderDomain={vi.fn()}
        />,
      )

      expect(screen.getByText('shop.com')).toBeInTheDocument()
    })

    it('does not render the candidate list when the suggestion messageId does not match this message', () => {
      const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: 'x' })]
      const result: DomainSuggestionResult = {
        ruleCandidates: [
          { domain: 'shop.com', label: 'shop', tld: '.com', origin: 'rule', reason: null, firstYearYen: null, caveat: null, orderable: true },
        ],
        aiCandidates: [],
        degraded: false,
        seedLabel: 'shop', droppedUnorderableCount: 0,
      }

      render(
        <MessageList
          messages={messages}
          onNavigate={vi.fn()}
          suggestion={{ status: 'done', result, messageId: 'm2' }}
          onOrderDomain={vi.fn()}
        />,
      )

      expect(screen.queryByText('shop.com')).not.toBeInTheDocument()
    })
  })

  describe('Guided Walkthrough', () => {
    const template = findWalkthroughTemplate('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE template not found')
    const walkthroughState: WalkthroughState = {
      templateId: 'CONNECT_WEBSITE',
      completedStepIds: [],
      visitedRouteIds: [],
      startedAt: 0,
      dismissedAt: null,
    }

    it('renders the WalkthroughCard after the newest assistant message when fully wired', () => {
      const messages: ChatMessage[] = [
        makeMessage({ id: 'm1', role: 'assistant', content: 'ご案内します。' }),
      ]

      render(
        <MessageList
          messages={messages}
          onNavigate={vi.fn()}
          walkthrough={{ template, state: walkthroughState }}
          onCompleteStep={vi.fn()}
          onRunStepAction={vi.fn()}
          onDismissWalkthrough={vi.fn()}
        />,
      )

      expect(screen.getByText(template.steps[0]!.title)).toBeInTheDocument()
    })

    it('renders nothing extra when walkthrough is passed but the callbacks are not (an unwired parent must not silently break)', () => {
      const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: 'ご案内します。' })]

      render(<MessageList messages={messages} onNavigate={vi.fn()} walkthrough={{ template, state: walkthroughState }} />)

      expect(screen.queryByText(template.steps[0]!.title)).not.toBeInTheDocument()
    })

    it('renders no walkthrough card when no walkthrough is active', () => {
      const messages: ChatMessage[] = [makeMessage({ id: 'm1', role: 'assistant', content: 'ご案内します。' })]

      render(<MessageList messages={messages} onNavigate={vi.fn()} />)

      expect(screen.queryByText(template.steps[0]!.title)).not.toBeInTheDocument()
    })
  })
})
