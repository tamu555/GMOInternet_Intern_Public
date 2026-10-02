/**
 * Regression guard for a wiring gap that unit tests could not catch: every
 * v1.4 capability (§30 Quick Actions, §31 domain candidates, §32 source cards)
 * is rendered by `MessageList` through OPTIONAL props. `AssistantModal` shipped
 * without passing them, so the whole feature compiled, type-checked and passed
 * its own component tests while being completely unreachable in the running
 * app. These tests drive the real modal, not `MessageList` in isolation.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageContext } from './types'

const { detectWebGpuMock } = vi.hoisted(() => ({
  detectWebGpuMock: vi.fn(async () => ({ available: true, shaderF16: false })),
}))
vi.mock('./engine/modelStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine/modelStatus')>()
  return { ...actual, detectWebGpu: detectWebGpuMock }
})

const { AssistantModal } = await import('./AssistantModal')
const { completeWalkthroughStep, getChatSnapshot, resetChatStoreForTest, startWalkthrough } = await import('./store/chatStore')
const { resetModelStoreForTest, setEngineFactoryForTest, startAssistantModelLoad } = await import('./store/modelStore')
const { createFakeAssistantEngine } = await import('./engine/fakeAssistantEngine')
const { setSuggestDomainsForTest } = await import('./useAssistantChat')
const { DOMAIN_CANDIDATES_EMPTY_MESSAGE, SUGGEST_DOMAINS_ACTION_LABEL } = await import('./assistantMessages')
const { findWalkthroughTemplate, templateForIntent } = await import('./walkthrough/walkthroughTemplates')
const { startWalkthroughActionLabel, WALKTHROUGH_STEP_OPEN_DOC_LABEL, WALKTHROUGH_UNDECIDED_ACTION_LABEL } = await import(
  './walkthrough/walkthroughMessages'
)
const { findRoute } = await import('./routing/routeManifest')
const { navigationCtaLabel } = await import('./assistantMessages')
const { buildSearchQuery, resolveDocSources } = await import('./docs/docResolver')

/** The §5.2 allowlisted fallback phrase for `custom-domain`, read from `docResolver` rather than restated (§14.2). */
const CUSTOM_DOMAIN_SEARCH_PHRASE = buildSearchQuery({ topic: 'custom-domain' })
if (CUSTOM_DOMAIN_SEARCH_PHRASE === null) throw new Error('custom-domain has no search phrase')

const CONTEXT: PageContext = { routeId: 'DOMAIN_SEARCH' }

/** A §11.3 wire payload that yields a keyword slot, so `deriveActions` emits SUGGEST_DOMAINS. */
const SEARCH_REPLY = [
  'intent: SEARCH_DOMAIN',
  'route: DOMAIN_SEARCH',
  'slots: keyword=panya',
  'confidence: 0.9',
  'clarify: no',
  '---',
  'ドメイン検索から始められます。',
].join('\n')

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  resetChatStoreForTest()
  resetModelStoreForTest()
  setSuggestDomainsForTest(null)
  detectWebGpuMock.mockResolvedValue({ available: true, shaderF16: false })
})

afterEach(() => {
  cleanup()
  setSuggestDomainsForTest(null)
  vi.restoreAllMocks()
})

async function openModalReady(reply: string) {
  setEngineFactoryForTest(() => createFakeAssistantEngine({ reply }))
  await act(async () => {
    await startAssistantModelLoad()
  })
  render(
    <MemoryRouter>
      <AssistantModal open={true} onOpenChange={vi.fn()} context={CONTEXT} />
    </MemoryRouter>,
  )
  return userEvent.setup()
}

/** Reflects the shared `MemoryRouter`'s current path as text - lets a test prove a real react-router navigate() happened without unmounting the modal it drove it from. */
function LocationDisplay() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}</p>
}

async function openModalReadyWithLocation(reply: string) {
  setEngineFactoryForTest(() => createFakeAssistantEngine({ reply }))
  await act(async () => {
    await startAssistantModelLoad()
  })
  render(
    <MemoryRouter>
      <LocationDisplay />
      <AssistantModal open={true} onOpenChange={vi.fn()} context={CONTEXT} />
    </MemoryRouter>,
  )
  return userEvent.setup()
}

describe('AssistantModal wires the v1.4 capabilities into the live UI', () => {
  it('renders a Quick Action button after a turn that produces one', async () => {
    const user = await openModalReady(SEARCH_REPLY)

    await user.type(screen.getByRole('textbox'), 'パン屋のサイトを作りたい{Enter}')

    // Proves the action is derived from the decision and rendered at all.
    // NOTE: this alone does NOT prove the wiring - `onRunAction` defaults to a
    // no-op, so the button renders even when the modal forgets to pass it.
    // The click test below is the one that actually guards that.
    expect(await screen.findByRole('button', { name: SUGGEST_DOMAINS_ACTION_LABEL })).toBeInTheDocument()
  })

  it('clicking SUGGEST_DOMAINS reaches suggestDomains exactly once, and never before the click (§8.4/FR-17)', async () => {
    const suggestSpy = vi.fn(async () => ({
      ruleCandidates: [],
      aiCandidates: [],
      degraded: false,
      seedLabel: 'panya', droppedUnorderableCount: 0,
    }))
    setSuggestDomainsForTest(suggestSpy)

    const user = await openModalReady(SEARCH_REPLY)
    await user.type(screen.getByRole('textbox'), 'パン屋のサイトを作りたい{Enter}')

    const button = await screen.findByRole('button', { name: SUGGEST_DOMAINS_ACTION_LABEL })
    // Nothing may have been fetched just by talking to the assistant.
    expect(suggestSpy).not.toHaveBeenCalled()

    await user.click(button)

    await waitFor(() => expect(suggestSpy).toHaveBeenCalledTimes(1))
    // And the RESULT must reach the UI too - that needs the `suggestion` prop
    // threaded through as well, not just `onRunAction`.
    expect(await screen.findByText(DOMAIN_CANDIDATES_EMPTY_MESSAGE)).toBeInTheDocument()
  })
})

describe('Guided Walkthrough wiring (the integration guard)', () => {
  it('shows the pinned stepper once a walkthrough starts, and a step action actually navigates', async () => {
    const user = await openModalReadyWithLocation(SEARCH_REPLY)
    await user.type(screen.getByRole('textbox'), 'パン屋のサイトを作りたい{Enter}')
    // Wait for the turn to settle so a real conversation exists in the store.
    await screen.findByRole('button', { name: SUGGEST_DOMAINS_ACTION_LABEL })

    const conversationId = getChatSnapshot().activeConversationId
    const template = findWalkthroughTemplate('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE template not found')

    // Driven directly, the same way `AssistantLauncher.test.tsx`'s headline
    // test does - starting a walkthrough is owned by a concurrent wave
    // (actions.ts/useAssistantChat.ts), out of this wave's scope.
    act(() => {
      startWalkthrough(conversationId, 'CONNECT_WEBSITE', Date.now())
    })

    expect(await screen.findByRole('navigation', { name: `${template.title}の進行状況` })).toBeInTheDocument()

    const firstStep = template.steps[0]
    if (!firstStep) throw new Error('CONNECT_WEBSITE has no steps')
    // The button names its DESTINATION (the Manifest's own screen title), not
    // the step - see `walkthroughStepActionLabel`.
    const domainListTitle = findRoute('DOMAIN_LIST')?.title
    if (!domainListTitle) throw new Error('DOMAIN_LIST missing from the Route Manifest')
    await user.click(screen.getByRole('button', { name: navigationCtaLabel(domainListTitle) }))

    // §9.3/§9.4: navigation went through react-router's navigate(), resolved
    // via the Route Manifest (DOMAIN_LIST -> /mypage) - never a hand-built path.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/mypage'))
  })
})

/**
 * Regression guard for the SECOND integration gap of this feature: the whole
 * guided walkthrough (templates, stepper, card, auto-detection) shipped with no
 * way to START it from a chat turn, because `actions.ts`/`useAssistantChat.ts`
 * belonged to a different agent's file list than the walkthrough UI. Exactly
 * the failure mode recorded as 決定31 - so it gets a test that drives the real
 * modal end to end.
 */
describe('AssistantModal starts a guided walkthrough from a chat turn (§34/W2)', () => {
  const CONNECT_REPLY = [
    'intent: CONNECT_WEBSITE',
    'route: DNS_RECORDS',
    'slots: provider=vercel',
    'confidence: 0.9',
    'clarify: no',
    '---',
    'DNS設定から接続できます。',
  ].join('\n')

  it('offers the walkthrough button and starting it renders the pinned stepper', async () => {
    const template = templateForIntent('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE walkthrough template missing')

    const user = await openModalReady(CONNECT_REPLY)
    await user.type(screen.getByRole('textbox'), 'Vercelでサイトを公開したい{Enter}')

    const startButton = await screen.findByRole('button', { name: startWalkthroughActionLabel(template.title) })
    // The walkthrough must NOT have started on its own (W2: user opts in).
    expect(screen.queryByRole('navigation', { name: `${template.title}の進行状況` })).not.toBeInTheDocument()

    await user.click(startButton)

    // The pinned stepper appearing proves runAction -> startWalkthrough ->
    // chatStore -> AssistantModal all actually connect.
    expect(await screen.findByRole('navigation', { name: `${template.title}の進行状況` })).toBeInTheDocument()
  })

  /**
   * ⚠️ A walkthrough step's OPEN_DOC action used to look documentation up with
   * NO provider, even in a conversation that had already established one. Since
   * `resolveDocSources` reads an absent provider as "provider-agnostic sources
   * only" (決定40(c)) and no provider-agnostic `custom-domain` entry exists, the
   * step ALWAYS fell through to the neutral Google query - while the very same
   * topic in the chat stream (`docActions`) produced Vercel's own page. Two
   * paths, same request, different documentation.
   */
  it("a step's OPEN_DOC action uses the provider the conversation already knows", async () => {
    const template = templateForIntent('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE walkthrough template missing')

    const user = await openModalReady(CONNECT_REPLY)
    await user.type(screen.getByRole('textbox'), 'Vercelでサイトを公開したい{Enter}')
    await user.click(await screen.findByRole('button', { name: startWalkthroughActionLabel(template.title) }))

    const docStep = template.steps.find((step) => step.action?.kind === 'OPEN_DOC')
    if (!docStep) throw new Error('CONNECT_WEBSITE has no OPEN_DOC step')
    // Steps before it are ticked so the OPEN_DOC step becomes the current one
    // (`WalkthroughCard` renders only the current step).
    const conversationId = getChatSnapshot().activeConversationId
    act(() => {
      for (const step of template.steps.slice(0, template.steps.indexOf(docStep))) {
        completeWalkthroughStep(conversationId, step.id)
      }
    })

    const expected = resolveDocSources({ providerId: 'vercel', topic: 'custom-domain' })[0]
    if (!expected) throw new Error('vercel custom-domain doc source missing from the registry')

    // Counted before/after rather than matched once: the SAME chat turn already
    // rendered these curated links as §32 source cards, so neither the link name
    // nor the search phrase is unique on the page. What is being tested is
    // whether the WALKTHROUGH path produces the same documentation the chat path
    // does - i.e. which of the two counts grows on the step's own click.
    const curatedLinks = () => screen.queryAllByRole('link', { name: new RegExp(expected.title) }).length
    const searchCards = () => screen.queryAllByText(CUSTOM_DOMAIN_SEARCH_PHRASE).length
    const curatedBefore = curatedLinks()
    const searchBefore = searchCards()

    await user.click(await screen.findByRole('button', { name: WALKTHROUGH_STEP_OPEN_DOC_LABEL }))

    await waitFor(() => expect(curatedLinks()).toBeGreaterThan(curatedBefore))
    // ...and NOT the neutral 「カスタムドメイン 設定方法」 query, which is what the step
    // produced before the fix. That fallback is only correct when no provider is
    // known - see the complementary test below.
    expect(searchCards()).toBe(searchBefore)

    // ⚠️ And it renders INSIDE the step's own card, not up in the pinned block
    // beside the stepper. The button sits at the bottom of a scrolled message
    // list, so a result painted above the fold looked to the user like the click
    // had done nothing at all.
    const walkthroughCard = screen.getByText(docStep.description).closest('[data-slot="card"]')
    if (!walkthroughCard) throw new Error('the walkthrough card was not found')
    expect(within(walkthroughCard as HTMLElement).getByRole('link', { name: new RegExp(expected.title) })).toBeInTheDocument()
  })

  it("drops a step's documentation once the walkthrough moves past that step", async () => {
    // `WalkthroughCard` renders only the CURRENT step, so documentation left
    // over from the previous one would sit under the next step's description and
    // read as if it documented that instead. Now that the cards live in the card
    // rather than in the pinned block, this is what keeps the move honest.
    const template = templateForIntent('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE walkthrough template missing')

    const user = await openModalReady(CONNECT_REPLY)
    await user.type(screen.getByRole('textbox'), 'Vercelでサイトを公開したい{Enter}')
    await user.click(await screen.findByRole('button', { name: startWalkthroughActionLabel(template.title) }))

    const docStep = template.steps.find((step) => step.action?.kind === 'OPEN_DOC')
    if (!docStep) throw new Error('CONNECT_WEBSITE has no OPEN_DOC step')
    const conversationId = getChatSnapshot().activeConversationId
    act(() => {
      for (const step of template.steps.slice(0, template.steps.indexOf(docStep))) {
        completeWalkthroughStep(conversationId, step.id)
      }
    })
    await user.click(await screen.findByRole('button', { name: WALKTHROUGH_STEP_OPEN_DOC_LABEL }))

    const cardFor = (description: string) => screen.getByText(description).closest('[data-slot="card"]') as HTMLElement | null
    await waitFor(() => expect(cardFor(docStep.description)).not.toBeNull())
    const before = within(cardFor(docStep.description)!).queryAllByRole('link').length
    expect(before).toBeGreaterThan(0)

    // Advance one step; the card now shows a different step entirely.
    act(() => completeWalkthroughStep(conversationId, docStep.id))

    const nextStep = template.steps[template.steps.indexOf(docStep) + 1]
    if (!nextStep) throw new Error('the OPEN_DOC step is the last one')
    await waitFor(() => expect(cardFor(nextStep.description)).not.toBeNull())
    expect(within(cardFor(nextStep.description)!).queryAllByRole('link')).toEqual([])
  })

  it('still falls back to the neutral search card while no provider is known', async () => {
    // The complement of the test above, and the state the reported screenshot
    // was actually in: with `provider` unfilled there is no vendor page to show,
    // and offering one company's manual to a user who named none is worse than
    // offering none (決定40(c)). Passing the provider through must not change
    // this half.
    const template = templateForIntent('CONNECT_WEBSITE')
    if (!template) throw new Error('CONNECT_WEBSITE walkthrough template missing')
    const noProviderReply = CONNECT_REPLY.replace('slots: provider=vercel', 'slots: ')

    const user = await openModalReady(noProviderReply)
    await user.type(screen.getByRole('textbox'), 'サイトを公開したい{Enter}')
    // ⚠️ NOT `startWalkthroughActionLabel` here: with `provider` unfilled the
    // very same button is relabelled as the answer to the provider question it
    // is shown beside. That this test would fail with the other label is the
    // in-situ proof of that relabelling.
    await user.click(await screen.findByRole('button', { name: WALKTHROUGH_UNDECIDED_ACTION_LABEL }))

    const docStep = template.steps.find((step) => step.action?.kind === 'OPEN_DOC')
    if (!docStep) throw new Error('CONNECT_WEBSITE has no OPEN_DOC step')
    const conversationId = getChatSnapshot().activeConversationId
    act(() => {
      for (const step of template.steps.slice(0, template.steps.indexOf(docStep))) {
        completeWalkthroughStep(conversationId, step.id)
      }
    })

    const searchCards = () => screen.queryAllByText(CUSTOM_DOMAIN_SEARCH_PHRASE).length
    const searchBefore = searchCards()

    await user.click(await screen.findByRole('button', { name: WALKTHROUGH_STEP_OPEN_DOC_LABEL }))

    await waitFor(() => expect(searchCards()).toBeGreaterThan(searchBefore))
    // No vendor page was invented for a provider the user never named.
    expect(screen.queryAllByRole('link', { name: /Vercel/ })).toEqual([])
  })
})
