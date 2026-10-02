import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantAction } from './actions'
import { QuickActions } from './QuickActions'

afterEach(cleanup)

const SET_SLOT_ACTION: AssistantAction = {
  kind: 'SET_SLOT',
  id: 'set-slot-provider-vercel',
  label: 'Vercel',
  payload: { slotKey: 'provider', value: 'vercel' },
}

const SUGGEST_DOMAINS_ACTION: AssistantAction = {
  kind: 'SUGGEST_DOMAINS',
  id: 'suggest-domains',
  label: 'ドメイン候補を探す',
  payload: { keywords: ['shop'] },
}

const OPEN_DOC_ACTION: AssistantAction = {
  kind: 'OPEN_DOC',
  id: 'open-doc-glossary-dns',
  label: 'DNS（ドメインネームシステム）とは',
  payload: { docId: 'glossary-dns' },
}

const RUN_WEB_SEARCH_ACTION: AssistantAction = {
  kind: 'RUN_WEB_SEARCH',
  id: 'run-web-search-nameserver',
  label: 'Googleで検索する',
  payload: { query: 'ネームサーバー 変更方法' },
}

describe('QuickActions', () => {
  it('renders nothing for an empty action list', () => {
    const { container } = render(<QuickActions actions={[]} onRun={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a SET_SLOT action as a button with its label', () => {
    render(<QuickActions actions={[SET_SLOT_ACTION]} onRun={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Vercel' })).toBeInTheDocument()
  })

  it('renders a SUGGEST_DOMAINS action as a button with its label', () => {
    render(<QuickActions actions={[SUGGEST_DOMAINS_ACTION]} onRun={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'ドメイン候補を探す' })).toBeInTheDocument()
  })

  it('renders an OPEN_DOC action through DocSourceCard (title, hostname, external link)', () => {
    render(<QuickActions actions={[OPEN_DOC_ACTION]} onRun={vi.fn()} />)
    // The title appears twice (the card heading and the link's own accessible
    // text) - `getAllByText` is used deliberately instead of `getByText`.
    expect(screen.getAllByText('DNS（ドメインネームシステム）とは').length).toBeGreaterThan(0)
    expect(screen.getByText(/jprs\.jp/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /DNS（ドメインネームシステム）とは/ })
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders a RUN_WEB_SEARCH action through SearchQueryCard (query text + search link)', () => {
    render(<QuickActions actions={[RUN_WEB_SEARCH_ACTION]} onRun={vi.fn()} />)
    expect(screen.getByText('ネームサーバー 変更方法')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Googleで検索する/ })).toBeInTheDocument()
  })

  it('calls onRun with the action when a SET_SLOT button is clicked', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<QuickActions actions={[SET_SLOT_ACTION]} onRun={onRun} />)

    await user.click(screen.getByRole('button', { name: 'Vercel' }))

    expect(onRun).toHaveBeenCalledWith(SET_SLOT_ACTION)
  })

  it('calls onRun with the action when the SUGGEST_DOMAINS button is clicked', async () => {
    const user = userEvent.setup()
    const onRun = vi.fn()
    render(<QuickActions actions={[SUGGEST_DOMAINS_ACTION]} onRun={onRun} />)

    await user.click(screen.getByRole('button', { name: 'ドメイン候補を探す' }))

    expect(onRun).toHaveBeenCalledWith(SUGGEST_DOMAINS_ACTION)
  })

  it('disables the SET_SLOT/SUGGEST_DOMAINS buttons when disabled', () => {
    render(<QuickActions actions={[SET_SLOT_ACTION, SUGGEST_DOMAINS_ACTION]} onRun={vi.fn()} disabled />)

    expect(screen.getByRole('button', { name: 'Vercel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'ドメイン候補を探す' })).toBeDisabled()
  })
})

describe('long button labels wrap instead of overflowing (regression)', () => {
  // Same root cause as `DocSourceCard`'s: `buttonVariants` is `whitespace-nowrap`
  // + `shrink-0` + fixed height by default, but several labels here are whole
  // Japanese phrases built by `actions.ts` (「Webサイトを公開する手順を見ながら進める」).
  const LONG_LABEL_ACTION: AssistantAction = {
    kind: 'START_WALKTHROUGH',
    id: 'start-walkthrough-connect-website',
    label: 'Webサイトを公開する手順を見ながら進める',
    payload: { templateId: 'CONNECT_WEBSITE' },
  }

  it('renders the button with wrapping enabled and no fixed height', () => {
    render(<QuickActions actions={[LONG_LABEL_ACTION]} onRun={vi.fn()} />)
    const button = screen.getByRole('button', { name: LONG_LABEL_ACTION.label })
    const className = button.getAttribute('class') ?? ''
    expect(className).toContain('whitespace-normal')
    expect(className).toContain('break-words')
    expect(className).toContain('h-auto')
    expect(className).toContain('max-w-full')
    expect(className).not.toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
  })
})
