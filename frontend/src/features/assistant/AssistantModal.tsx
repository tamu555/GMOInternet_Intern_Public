/**
 * Chat modal (spec browser-ai.md §13.2, §13.3). Follows `RecipeDialog.tsx`'s
 * split exactly: this component owns only `open`/`onOpenChange` and wires
 * `<Dialog><DialogContent><AssistantModalBody .../></DialogContent></Dialog>`;
 * every other piece of state (the whole `useAssistantChat` controller) lives
 * in `AssistantModalBody`, in this same file, because Radix unmounts
 * `DialogContent` while closed - the body's state resets for free every time
 * it reopens, which is deliberate, not an oversight (same reasoning as
 * `RecipeDialog`/`PasteDialog`).
 */
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { AssistantError } from './AssistantError'
import { AssistantHeader } from './AssistantHeader'
import { ChatInput } from './ChatInput'
import { ConversationTabs } from './ConversationTabs'
import { emitAssistantEvent } from './events'
import { MessageList } from './MessageList'
import { ModelLoading } from './ModelLoading'
import { SUGGEST_DOMAINS_ACTION_LABEL } from './assistantMessages'
import { buildSearchQuery, resolveDocSources, topicForProvider } from './docs/docResolver'
import type { AssistantDocSource } from './docs/docSources'
import { resolveNavigation } from './routing/manifestResolver'
import { validateLabelSlotValue } from './routing/playbooks'
import type { NavigationSuggestion, PageContext } from './types'
import { useAssistantChat } from './useAssistantChat'
import { WalkthroughStepper } from './WalkthroughStepper'
import { completeWalkthroughStep, dismissActiveWalkthrough, recordWalkthroughRouteVisit } from './store/chatStore'
import { WALKTHROUGH_STEPPER_COLLAPSE_LABEL, WALKTHROUGH_STEPPER_EXPAND_LABEL } from './walkthrough/walkthroughMessages'
import { currentStep } from './walkthrough/walkthroughState'
import { findWalkthroughTemplate } from './walkthrough/walkthroughTemplates'
import type { WalkthroughStep } from './walkthrough/walkthroughTemplates'

export interface AssistantModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: PageContext
  /**
   * Forwarded verbatim to `DialogContent`. `AssistantLauncher` uses it to hand
   * focus back to its own button on close (WCAG 2.4.3) - Radix restores focus
   * to a `DialogTrigger`, and this modal has none.
   */
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus']
}

export function AssistantModal({ open, onOpenChange, context, onCloseAutoFocus }: AssistantModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix はクローズ中 DialogContent をアンマウントするので、
          useAssistantChat の状態（会話のフェッチ・生成中フラグ等）は
          開くたびに初期化される（RecipeDialog / PasteDialog と同じ構造）。
          §20.1 の chat_opened/chat_closed は、このアンマウント特性を使って
          AssistantModalBody のマウント/アンマウントで発火する - AssistantLauncher
          のボタン押下（DialogTrigger を介さない）でも Esc / オーバーレイ操作
          でも同じ経路で発火する。
          §13.3 の ⚠️: Radix は role="dialog" のみ付与し aria-modal は明示
          しないため、ここで明示的に付与する。 */}
      {/*
       * This modal owns its own box sizing in BOTH axes, overriding
       * `DialogContent`'s default `grid` layout - the shared component
       * (components/ui/dialog.tsx) stays untouched.
       *
       * ⚠️ Both halves were measured in a real browser; jsdom has no layout
       * engine and can see neither (§0.4.3).
       *
       * Horizontal - `flex flex-col`: with `DialogContent`'s default single
       * `auto` grid column, the track is sized to the WIDEST item's max-content.
       * A long conversation-tab strip made that track 872px inside a 672px
       * panel, and since grid items stretch to the track, EVERY child became
       * 872px - header buttons, error alert and message list all spilled out of
       * the white panel together. `min-w-0` on the children does not help: it
       * removes an item's minimum floor, but nothing stops an `auto` track from
       * growing to max-content. A column flex container has no such track -
       * children stretch to the CONTAINER's width - so the overflow containers
       * inside finally have a bounded box to scroll within. They still need
       * their own `min-w-0`, which is why both halves of that fix exist.
       *
       * Vertical - `sm:h-[42rem]` capped by `max-h-[calc(100dvh-2rem)]`: the
       * message list used to carry `max-h-[70vh]` while everything around it
       * (header, stepper, tabs, input, notice) was unbounded, so the total
       * could exceed the viewport for ANY viewport height. Measured at 1512x880 with a walkthrough running: the
       * panel was 917px tall, top=-18, bottom=898 - clipped off BOTH edges,
       * exactly the reported screenshot. Capping the panel and letting the
       * message list be the one flexible row (`min-h-0 flex-1`, below) makes the
       * modal fit any viewport and scroll internally instead. `dvh` rather than
       * `vh` so a mobile browser's retracting URL bar cannot re-introduce it.
       *
       * ...but a cap alone leaves the height content-driven, so a short or
       * empty conversation collapsed the panel: measured at 1280x900 it was
       * 672x332, a 2:1 landscape slab. `sm:h-[42rem]` gives it an explicit
       * 672px - exactly what `sm:max-w-2xl` is wide - so the desktop panel is
       * square (1:1), which is what was asked for. The cap is NOT redundant:
       * CSS `max-height` beats `height`, so the real height is
       * `min(672px, 100dvh - 2rem)` and a 700px-tall window still gets a panel
       * that fits. `sm:`-only on purpose - below 640px the panel keeps
       * `DialogContent`'s full-width-minus-margins box and stays
       * content-height, so a phone never has a 672px box forced onto it. The
       * extra height lands entirely on the message list, since that is the one
       * `min-h-0 flex-1` row; header, tabs and input keep their intrinsic
       * height and the empty-state text just centres in a taller area.
       */}
      <DialogContent
        aria-modal="true"
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:h-[42rem] sm:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <AssistantModalBody context={context} onOpenChange={onOpenChange} />
      </DialogContent>
    </Dialog>
  )
}

function AssistantModalBody({
  context,
  onOpenChange,
}: {
  context: PageContext
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const {
    activeConversation,
    modelState,
    busy,
    sendMessage,
    newConversation,
    selectConversation,
    deleteConversation,
    deleteAllConversations,
    retryModelLoad,
    grantConsent,
    runAction,
    suggestion,
    store,
  } = useAssistantChat(context)

  // Guided Walkthrough (`.agents/docs/research/assistant-walkthrough-plan.md`
  // §4.1/§6): the active conversation's own `walkthrough` field, resolved to
  // its compile-time template. `dismissedAt !== null` ("やめる") hides both
  // the pinned stepper and the in-message card, but leaves the stored
  // progress alone so it can resume later (see `walkthroughState.ts`'s
  // `dismissWalkthrough` doc).
  const walkthroughState = activeConversation.walkthrough ?? null
  const walkthroughTemplate = walkthroughState ? findWalkthroughTemplate(walkthroughState.templateId) : undefined
  const showWalkthrough = walkthroughState !== null && walkthroughTemplate !== undefined && walkthroughState.dismissedAt === null

  // Kept small so the stepper can never eat the whole modal height (team-lead
  // directive) - default expanded; collapsing swaps in the same compact
  // one-line summary `AppLayout`'s out-of-modal bar uses.
  const [stepperExpanded, setStepperExpanded] = useState(true)

  // OPEN_DOC/RUN_WEB_SEARCH step actions resolve to the SAME cards §32 already
  // defines (`DocSourceCard`/`SearchQueryCard`) - never a second link
  // component. The state lives here because `handleRunStepAction` below is what
  // resolves them, but they are RENDERED by `WalkthroughCard`, inside the very
  // card whose button produced them - see that component's `docSources` doc for
  // why they are no longer painted up in the pinned block.
  /**
   * ⚠️ Stamped with the step it was resolved FOR, and read back only while that
   * step is still the current one. `WalkthroughCard` renders only the current
   * step, so documentation left over from the previous one would sit under the
   * NEXT step's description and read as if it documented that instead.
   *
   * Written as an identity carried WITH the data rather than as an effect that
   * clears it on step change: an effect would be a second source of truth
   * racing the render (and `react(set-state-in-effect)` flags exactly that).
   * This way the stale case cannot be rendered even for one frame, and it
   * covers dismissing the walkthrough and switching conversations for free -
   * both change `currentStepId` too.
   */
  const [stepDocs, setStepDocs] = useState<{
    stepId: string | null
    sources: AssistantDocSource[]
    searchQuery: string | null
  } | null>(null)

  const currentStepId =
    showWalkthrough && walkthroughTemplate && walkthroughState
      ? (currentStep(walkthroughTemplate, walkthroughState)?.id ?? null)
      : null
  const activeStepDocs = stepDocs !== null && stepDocs.stepId === currentStepId ? stepDocs : null

  // §20.1: fires exactly once per open (mount) and once per close (unmount),
  // regardless of what triggered either - AssistantLauncher's button doesn't
  // go through a Radix DialogTrigger, so this can't be wired via Dialog's own
  // onOpenChange.
  useEffect(() => {
    emitAssistantEvent({ type: 'chat_opened' })
    return () => emitAssistantEvent({ type: 'chat_closed' })
  }, [])

  function handleNavigate(navigation: NavigationSuggestion): void {
    // §9.3/§9.4: only ever an internal react-router navigate() - never
    // window.location, never an <a href>, and `navigation.resolvedPath` is
    // already Manifest-resolved by the controller hook/routeValidator.
    navigate(navigation.resolvedPath)
    onOpenChange(false)
    emitAssistantEvent({ type: 'navigation_clicked', routeId: navigation.routeId })
  }

  /**
   * v1.4 §31.2: a domain candidate's 申し込む button. The path was built by
   * `orderPathForDomain()` from an availability-verified candidate and
   * re-validated against the priced-TLD table, so it can only ever be
   * `/domains/new?domain=…` - the LLM never influences it (§9.3). Navigation
   * itself goes through react-router exactly like `handleNavigate`, never
   * `window.location`, and closing the modal matches what a Navigation Card
   * click does.
   */
  function handleOrderDomain(path: string): void {
    navigate(path)
    onOpenChange(false)
  }

  /**
   * `WalkthroughCard`'s action button. Every branch below is built entirely
   * from `step.action` - a compile-time constant from `walkthroughTemplates.ts`,
   * never anything the LLM produced (FR-21).
   */
  function handleRunStepAction(step: WalkthroughStep): void {
    const action = step.action
    if (!action) return

    switch (action.kind) {
      case 'NAVIGATE': {
        // §9.3/§9.4: resolved the same way `handleNavigate` resolves a
        // Navigation Card - through the Manifest, never a hand-built path.
        // `resolveNavigation` returns `null` for a disabled/unknown route, in
        // which case this is a deliberate no-op rather than a fallback
        // navigation to somewhere the step never asked for.
        if (!action.routeId) return
        const navigation = resolveNavigation(action.routeId, context)
        if (!navigation) return
        // Record the visit explicitly rather than relying on `AssistantLauncher`'s
        // location effect. ⚠️ That effect is keyed on the resolved RouteId, so it
        // does NOT re-fire when the user is ALREADY on the step's page - which is
        // the common case, since the assistant is usually opened from the page the
        // step is about. Without this, `recordRouteVisit`'s "only while the step is
        // current" gate would leave such a step permanently uncompletable. Clicking
        // this button is the explicit "I am doing this step now" signal the gate
        // wants, so it is the right place to record from.
        recordWalkthroughRouteVisit(navigation.routeId)
        navigate(navigation.resolvedPath)
        onOpenChange(false)
        emitAssistantEvent({ type: 'navigation_clicked', routeId: navigation.routeId })
        return
      }
      case 'OPEN_DOC':
      case 'RUN_WEB_SEARCH': {
        // §32: the curated registry first, the allowlisted search-phrase
        // fallback only when nothing curated matches this topic - exactly
        // `docActions`'s own rule 3/rule 4 order in `actions.ts`.
        //
        // ⚠️ `providerId` used to be omitted here, so this path could never
        // reach a vendor's own page: `resolveDocSources` reads an absent
        // provider as "provider-agnostic sources only" (decision 40(c)), and no
        // provider-agnostic `custom-domain` entry exists, so every OPEN_DOC step
        // fell through to the neutral Google query - even in a conversation that
        // had already established `provider=vercel`. The same step in the chat
        // stream (`actions.ts`'s `docActions`) DID pass it, so the two paths
        // showed different documentation for the same request. The value comes
        // from `GoalState.slots`, which only ever holds Playbook-validated
        // values, and both functions below match it against their own static
        // tables regardless - no user free text can reach them (see
        // `buildSearchQuery`'s own doc).
        const providerId = activeConversation.goal?.slots.provider ?? null
        // A `mode: 'ns-guide'` provider is connected by changing nameservers, so
        // its page is filed under `nameserver`, not `custom-domain` - the same
        // branch `docActions` gets from `topicForIntentAndProvider`.
        const lookup = { providerId, topic: topicForProvider(action.docTopic ?? null, providerId) }
        const sources = resolveDocSources(lookup)
        setStepDocs({
          stepId: currentStepId,
          sources,
          searchQuery: sources.length > 0 ? null : buildSearchQuery(lookup),
        })
        return
      }
      case 'SUGGEST_DOMAINS': {
        // v1.4 §8.4/FR-17: the ONLY way this ever reaches `suggestDomains()`
        // is the hook's own guarded `runAction` - no template may call the
        // network directly.
        const rawKeyword = activeConversation.goal?.slots.keyword
        const keywords = rawKeyword ? validateLabelSlotValue(rawKeyword) : []
        runAction({
          kind: 'SUGGEST_DOMAINS',
          id: 'walkthrough-suggest-domains',
          label: SUGGEST_DOMAINS_ACTION_LABEL,
          payload: { keywords },
        })
        return
      }
    }
  }

  // §16: no ChatInput for UNSUPPORTED/ERROR - there is nothing to send to
  // (ERROR still shows a retry). Everything else (§6.4.1: NOT_STARTED /
  // CHECKING / AWAITING_CONSENT / DOWNLOADING / INITIALIZING / READY) keeps
  // the input usable - a message sent before READY queues as `pending`.
  //
  // This also decides whether the persistent "AI answers can be wrong" notice
  // shows (`ChatInput.tsx` renders `AI_GENERATED_CONTENT_NOTICE` itself, right
  // below its char counter) - deliberately the SAME condition, not a separate
  // one: UNSUPPORTED/ERROR already render `AssistantError` explaining the AI
  // is unavailable, and with no reply ever in flight there, the notice would
  // have nothing to disclaim.
  const showChatInput = modelState.status !== 'UNSUPPORTED' && modelState.status !== 'ERROR'

  let statusPanel: ReactNode = null
  if (modelState.status === 'UNSUPPORTED') {
    statusPanel = <AssistantError errorKind="unsupported" onRetry={retryModelLoad} />
  } else if (modelState.status === 'ERROR') {
    statusPanel = <AssistantError errorKind={modelState.errorKind ?? 'load_failed'} onRetry={retryModelLoad} />
  } else if (modelState.status !== 'READY') {
    statusPanel = <ModelLoading state={modelState} onConsent={grantConsent} />
  }

  return (
    <>
      <AssistantHeader
        onNewConversation={newConversation}
        onDeleteAll={deleteAllConversations}
        canDeleteAll={store.conversations.length > 0}
      />

      {showWalkthrough && walkthroughTemplate && walkthroughState ? (
        <div className="flex flex-col gap-2 border-b border-border pb-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {stepperExpanded ? (
                <WalkthroughStepper variant="full" template={walkthroughTemplate} state={walkthroughState} />
              ) : (
                <WalkthroughStepper variant="compact" template={walkthroughTemplate} state={walkthroughState} />
              )}
            </div>
            {/*
             * Icon-only, not a text button. ⚠️ Measured: with the 「手順をたたむ」
             * text button (~110px) taking room from the same row, the step row
             * had 534px of usable width for 649px of steps, so the LAST step's
             * label was permanently clipped behind this button - the reported
             * bug. An icon button gives ~80px of that back. The accessible name
             * is unchanged (`aria-label`), and `title` keeps it discoverable on
             * hover for sighted users.
             */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              aria-label={stepperExpanded ? WALKTHROUGH_STEPPER_COLLAPSE_LABEL : WALKTHROUGH_STEPPER_EXPAND_LABEL}
              title={stepperExpanded ? WALKTHROUGH_STEPPER_COLLAPSE_LABEL : WALKTHROUGH_STEPPER_EXPAND_LABEL}
              onClick={() => setStepperExpanded((prev) => !prev)}
            >
              {stepperExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </Button>
          </div>
        </div>
      ) : null}

      <ConversationTabs
        conversations={store.conversations}
        activeConversationId={store.activeConversationId}
        onSelect={selectConversation}
        onDelete={deleteConversation}
        onCreate={newConversation}
      />

      {statusPanel}

      {/*
       * `MessageList`/`ChatInput` are rendered exactly once, unconditionally,
       * rather than duplicated per status branch above: `ModelStatus` can
       * flip (e.g. DOWNLOADING -> READY) while the user is mid-keystroke in
       * `ChatInput`, and duplicating the element per branch would make React
       * unmount/remount a *different* element on that transition, silently
       * discarding whatever was already typed. One stable element persists
       * through every status transition instead.
       */}
      {/*
       * The one flexible row of the column: `flex-1` takes whatever height is
       * left after the fixed chrome, and `min-h-0` is what lets it actually
       * shrink - a column flex item's default `min-height: auto` refuses to go
       * below its content, which would push the panel past its own `max-h` and
       * put us straight back to the clipped-off-both-edges bug. Replaces a
       * fixed `max-h-[70vh]`, which could not know how much room the header,
       * stepper, tabs, input and notice around it had already taken.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* v1.4: `onRunAction`/`suggestion`/`onOrderDomain` are what make §30's
            Quick Actions, §32's source cards and §31's domain candidates
            actually reachable in the running app - `MessageList` accepts them
            as optional props, so omitting them compiles and tests fine but
            silently renders no buttons. */}
        <MessageList
          messages={activeConversation.messages}
          onNavigate={handleNavigate}
          onRunAction={runAction}
          suggestion={suggestion}
          onOrderDomain={handleOrderDomain}
          walkthrough={
            showWalkthrough && walkthroughTemplate && walkthroughState
              ? {
                  template: walkthroughTemplate,
                  state: walkthroughState,
                  docSources: activeStepDocs?.sources,
                  searchQuery: activeStepDocs?.searchQuery ?? null,
                }
              : null
          }
          onCompleteStep={(stepId) => completeWalkthroughStep(activeConversation.id, stepId)}
          onRunStepAction={handleRunStepAction}
          onDismissWalkthrough={() => dismissActiveWalkthrough(activeConversation.id, Date.now())}
        />
      </div>
      {showChatInput ? <ChatInput onSubmit={sendMessage} busy={busy} /> : null}
    </>
  )
}
