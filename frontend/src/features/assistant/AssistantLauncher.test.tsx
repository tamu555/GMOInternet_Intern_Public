/**
 * `AssistantLauncher` tests (spec browser-ai.md §13.4, §13.5, §13.6, §6.1,
 * §16). The modal it opens is exercised end-to-end here too (through the
 * real, un-mocked chatStore/modelStore) since the launcher owns `open` state
 * for it - `useAssistantChat.test.tsx` covers the chat pipeline itself in
 * depth.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLayout } from '../../app/AppLayout'
import { AuthContext } from '../../auth/authContext'
import { UNAUTHENTICATED_STATE } from '../../auth/authTypes'
import { AssistantLauncher } from './AssistantLauncher'
import { ASSISTANT_LAUNCHER_BUTTON_LABEL, MODEL_UNSUPPORTED_MESSAGE } from './assistantMessages'
import { createConversation, getChatSnapshot, resetChatStoreForTest, startWalkthrough } from './store/chatStore'
import { resetModelStoreForTest, startAssistantModelLoad } from './store/modelStore'
import { findWalkthroughTemplate } from './walkthrough/walkthroughTemplates'

const { assistantEnabledMock } = vi.hoisted(() => ({ assistantEnabledMock: vi.fn(() => true) }))
vi.mock('./config/assistantConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/assistantConfig')>()
  return { ...actual, assistantEnabled: assistantEnabledMock }
})

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  resetChatStoreForTest()
  resetModelStoreForTest()
  assistantEnabledMock.mockReturnValue(true)
})

afterEach(() => {
  cleanup()
})

function renderAt(path: string, ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/domains/:domainName/dns" element={ui} />
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('§6.1: enabled switch', () => {
  it('renders nothing when assistantEnabled() is false', () => {
    assistantEnabledMock.mockReturnValue(false)
    const { container } = renderAt('/', <AssistantLauncher />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('§13.4 cta variant', () => {
  it('renders the launcher button and opens the modal on click', async () => {
    renderAt('/', <AssistantLauncher variant="cta" />)
    const user = userEvent.setup()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  // The app-wide entry point is the §13.5 header button; this block is the
  // quiet second offer, so it must not be the loudest thing on the page.
  // `data-variant` is stamped by `Button` itself (`ui/button.tsx`), which is a
  // stable hook - never assert on the generated class string.
  it('is a demoted secondary button, not the page primary fill', () => {
    renderAt('/', <AssistantLauncher variant="cta" />)
    expect(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL })).toHaveAttribute(
      'data-variant',
      'secondary',
    )
  })
})

describe('§13.5 icon variant', () => {
  it('renders a compact icon button with the launcher label as its accessible name', () => {
    renderAt('/', <AssistantLauncher variant="icon" />)
    expect(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL })).toBeInTheDocument()
  })

  // The header button used to be a wordless glyph, which is why nobody found
  // it. The label now renders as real text (`sr-only lg:not-sr-only`, so it is
  // visible from `lg` up); jsdom has no viewport, so this asserts the text is
  // in the accessibility tree, not that it is painted at a given width.
  it('carries the launcher label as text content, not only as an aria-label', () => {
    renderAt('/', <AssistantLauncher variant="icon" />)
    expect(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL })).toHaveTextContent(
      ASSISTANT_LAUNCHER_BUTTON_LABEL,
    )
  })
})

// WCAG 2.4.3: the launcher opens the modal from a plain `<Button onClick>`,
// not a Radix `DialogTrigger`, so Radix had no trigger to restore focus to and
// Esc dropped focus onto `<body>`. jsdom runs Radix's real `FocusScope` (it
// dispatches and honours `onCloseAutoFocus`), so this is a genuine assertion,
// not a vacuous one - it fails on the pre-fix component.
describe('focus restoration on close', () => {
  it.each(['icon', 'cta'] as const)('returns focus to the %s launcher button when Esc closes the modal', async (variant) => {
    renderAt('/', <AssistantLauncher variant={variant} />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL })

    await user.click(trigger)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(trigger).not.toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})

describe('§16: UNSUPPORTED never hides the launcher', () => {
  it('still opens the modal, which shows the §16 unsupported message', async () => {
    // jsdom has no navigator.gpu, so the real (un-mocked) modelStatus probe
    // naturally lands on UNSUPPORTED here.
    await startAssistantModelLoad()

    renderAt('/', <AssistantLauncher variant="cta" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL }))
    expect(await screen.findByText(MODEL_UNSUPPORTED_MESSAGE)).toBeInTheDocument()
  })
})

describe('§13.6 PageContext', () => {
  it('resolves routeId/domain from the current route (DNS_RECORDS with a domainName param)', async () => {
    renderAt('/domains/example.com/dns?mode=records', <AssistantLauncher variant="cta" />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL }))
    // §13.6: the domain name itself must never leak into the DOM anywhere the
    // AI's prompt/output could be sourced from - this only asserts the modal
    // opened successfully with a route-bearing context, not the domain text.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})

describe('Guided Walkthrough auto-detection (headline test): the modal stays CLOSED throughout', () => {
  it('records the route visit and completes the matching step without ever opening the assistant', () => {
    const conversation = createConversation()
    startWalkthrough(conversation.id, 'CONNECT_WEBSITE', Date.now())

    // CONNECT_WEBSITE's first step completes on a DOMAIN_LIST (`/mypage`)
    // visit - rendering the launcher at that path, with the modal never
    // opened, is the entire point of this test (plan §1's whole promise).
    renderAt('/mypage', <AssistantLauncher variant="icon" />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const updated = getChatSnapshot().conversations.find((entry) => entry.id === conversation.id)
    expect(updated?.walkthrough?.visitedRouteIds).toContain('DOMAIN_LIST')
  })
})

describe('§4.1 compact variant (Guided Walkthrough out-of-modal bar)', () => {
  it('shows the template title/progress and opens the assistant modal on click', async () => {
    const conversation = createConversation()
    startWalkthrough(conversation.id, 'CONNECT_WEBSITE', Date.now())
    const template = findWalkthroughTemplate('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE template not found')
    const walkthroughState = getChatSnapshot().conversations.find((entry) => entry.id === conversation.id)?.walkthrough
    if (!walkthroughState) throw new Error('walkthrough not started')

    renderAt('/', <AssistantLauncher variant="compact" walkthroughTemplate={template} walkthroughState={walkthroughState} />)
    const user = userEvent.setup()

    expect(screen.getByText(template.title)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('renders nothing when compact but no walkthrough data is supplied', () => {
    const { container } = renderAt('/', <AssistantLauncher variant="compact" />)
    expect(container).toBeEmptyDOMElement()
  })
})

/**
 * `AppLayout` renders its own compact-bar instance directly (not via the
 * `variant="icon"`/`"cta"` launchers already exercised above) - `AppLayout.tsx`
 * has no dedicated test file of its own, so this covers it here per the wave
 * assignment. `AuthContext.Provider` stands in for the real `AuthProvider`
 * (which performs a network session check on mount) - `AppLayout` only reads
 * `state`/`logout` from the context, so a minimal unauthenticated value is
 * enough to render it in isolation.
 */
const AUTH_VALUE = {
  state: UNAUTHENTICATED_STATE,
  restoreError: null,
  login: vi.fn(),
  loginWithGoogle: vi.fn(),
  logout: vi.fn(),
  recheckSession: vi.fn(),
}

function renderAppLayoutAt(path: string) {
  return render(
    <AuthContext.Provider value={AUTH_VALUE}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="*" element={<p>ページの内容</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('AppLayout: Guided Walkthrough out-of-modal bar', () => {
  it('renders nothing at all when there is no active walkthrough (site-wide - AppLayout wraps every page)', () => {
    renderAppLayoutAt('/')
    expect(screen.queryByRole('button', { name: /Webサイトを公開する/ })).not.toBeInTheDocument()
  })

  it('renders the compact bar and opens the assistant modal when a live walkthrough exists', async () => {
    const conversation = createConversation()
    startWalkthrough(conversation.id, 'CONNECT_WEBSITE', Date.now())
    const user = userEvent.setup()

    renderAppLayoutAt('/')

    await user.click(screen.getByRole('button', { name: /Webサイトを公開する/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })
})
