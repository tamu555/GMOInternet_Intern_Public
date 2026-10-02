/**
 * Chat transcript (spec browser-ai.md §12.7, §17.4).
 *
 * §12.7 / OWASP LLM05 (Improper Output Handling): a message's `content` is
 * rendered ONLY as a plain-text React child - never `dangerouslySetInnerHTML`,
 * never parsed as Markdown/HTML, never used to build an `<a>`. React escapes
 * text children automatically, so a payload like `<img src=x onerror=...>`
 * stays literal text and can never become a live DOM element. Newlines are
 * preserved with the `whitespace-pre-wrap` CSS class, not by injecting `<br>`.
 *
 * §17.4: a streaming reply must be announced to a screen reader once, when it
 * settles - not once per token. The single visible text node is marked
 * `aria-hidden="true"` while `status === 'streaming'`, which removes it (and
 * every mutation inside it) from the accessibility tree; `aria-live="polite"`
 * `aria-atomic="false"` sits on the list container, so the moment a message
 * stops streaming and `aria-hidden` is lifted, that newly-exposed text is
 * what gets announced - exactly once.
 */
import { Fragment, useEffect, useRef } from 'react'
import { NavigationCard } from './NavigationCard'
import { QuickActions } from './QuickActions'
import { DomainCandidateList } from './DomainCandidateList'
import { WalkthroughCard } from './WalkthroughCard'
import {
  ASSISTANT_MESSAGE_ROLE_LABEL,
  EMPTY_CONVERSATION_HINT,
  MESSAGE_STATUS_FAILED_HINT,
  MESSAGE_STATUS_PENDING_HINT,
  MESSAGE_STREAMING_HINT,
  USER_MESSAGE_ROLE_LABEL,
} from './assistantMessages'
import type { AssistantAction } from './actions'
import type { AssistantDocSource } from './docs/docSources'
import type { DomainSuggestionResult } from './suggest/domainSuggestion'
import type { ChatMessage, NavigationSuggestion, WalkthroughState } from './types'
import type { WalkthroughStep, WalkthroughTemplate } from './walkthrough/walkthroughTemplates'

/**
 * v1.4: the most recent SUGGEST_DOMAINS result (design contract §4.2),
 * paired with the id of the assistant message it belongs to. `ChatMessage`
 * itself has no field for this - `navigation`/`actions` are the only
 * additive `ChatMessage` fields the design contract defines (§2.1/§3) - so
 * this is threaded alongside `messages` instead, letting `MessageList` still
 * render the candidate list directly beneath the message that requested it.
 */
export interface MessageListSuggestionState {
  status: 'idle' | 'loading' | 'done' | 'error'
  result: DomainSuggestionResult | null
  messageId: string | null
}

/**
 * Guided Walkthrough (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §4.2/§6): the active walkthrough this conversation is running, if any -
 * paired `template`/`state` so `WalkthroughCard` never has to re-resolve the
 * template itself.
 */
export interface MessageListWalkthroughState {
  template: WalkthroughTemplate
  state: WalkthroughState
  /**
   * The §32 cards the CURRENT step's `OPEN_DOC`/`RUN_WEB_SEARCH` action
   * produced, if the user has clicked it - owned by `AssistantModal` (it is
   * transient UI state, not conversation content, so `ChatMessage` has no field
   * for it) and rendered by `WalkthroughCard` directly beneath the button that
   * produced them. Absent/empty until that click, and cleared whenever the
   * current step changes.
   */
  docSources?: readonly AssistantDocSource[]
  searchQuery?: string | null
}

/** No-op fallback so a caller that has not yet wired `onRunAction` (see the module doc's wiring note) does not crash - QuickActions always gets a callable `onRun`. */
function noopRunAction(): void {}

export interface MessageListProps {
  messages: readonly ChatMessage[]
  onNavigate: (navigation: NavigationSuggestion) => void
  /**
   * v1.4 (design contract §3). Optional, defaulting to a no-op: the caller
   * that owns wiring this to `useAssistantChat().runAction` (`AssistantModal.tsx`)
   * is outside this wave's owned files (see the wave report) - keeping this
   * optional means `MessageList` still compiles/renders correctly for any
   * caller that has not yet been updated to pass it, while fully supporting
   * Quick Actions for any caller (including this component's own tests) that
   * does.
   */
  onRunAction?: (action: AssistantAction) => void
  /** See `MessageListSuggestionState`. Omit/`null` when no SUGGEST_DOMAINS action has run yet. */
  suggestion?: MessageListSuggestionState | null
  /** Where a candidate's 申し込む button navigates (design contract §4.2: `/domains/new?domain=…`, built by `orderPathForDomain`). Same optionality note as `onRunAction`. */
  onOrderDomain?: (path: string) => void
  /**
   * `.agents/docs/research/assistant-walkthrough-plan.md` §4.2. `null`/omitted
   * when no walkthrough is active for this conversation. `onCompleteStep`/
   * `onRunStepAction`/`onDismissWalkthrough` are required together with
   * `walkthrough` (see the `WalkthroughCard` render below) - same optionality
   * note as `onRunAction`/`onOrderDomain`: the caller that wires this
   * (`AssistantModal.tsx`) owns actually calling `store/chatStore.ts`.
   */
  walkthrough?: MessageListWalkthroughState | null
  onCompleteStep?: (stepId: string) => void
  onRunStepAction?: (step: WalkthroughStep) => void
  onDismissWalkthrough?: () => void
}

export function MessageList({
  messages,
  onNavigate,
  onRunAction = noopRunAction,
  suggestion = null,
  onOrderDomain,
  walkthrough = null,
  onCompleteStep,
  onRunStepAction,
  onDismissWalkthrough,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = bottomRef.current
    // jsdom has no layout engine and therefore no real scrollIntoView.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'end' })
    }
  }, [messages])

  // All three callbacks must be present for the card to have anywhere to
  // report progress to - same "fully wired or not rendered at all" guard as
  // `candidateResult`/`onOrderDomain` above.
  const walkthroughCard =
    walkthrough && onCompleteStep && onRunStepAction && onDismissWalkthrough ? (
      <WalkthroughCard
        template={walkthrough.template}
        state={walkthrough.state}
        docSources={walkthrough.docSources}
        searchQuery={walkthrough.searchQuery}
        onCompleteStep={onCompleteStep}
        onRunStepAction={onRunStepAction}
        onDismiss={onDismissWalkthrough}
      />
    ) : null

  if (messages.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="py-8 text-center text-sm text-muted-foreground">{EMPTY_CONVERSATION_HINT}</p>
        {walkthroughCard}
      </div>
    )
  }

  // "After the newest assistant message" - falls back to the very last
  // message when the conversation has no assistant message yet (e.g. a
  // walkthrough started before the model has replied at all), so the card is
  // never silently stranded off-screen.
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant')
  const anchorMessageId = (lastAssistantMessage ?? messages[messages.length - 1]).id

  return (
    <div className="flex flex-col gap-3" aria-live="polite" aria-atomic="false">
      {messages.map((message) => (
        <Fragment key={message.id}>
          <MessageRow
            message={message}
            onNavigate={onNavigate}
            onRunAction={onRunAction}
            candidateResult={suggestion?.messageId === message.id ? suggestion.result : null}
            onOrderDomain={onOrderDomain}
          />
          {message.id === anchorMessageId ? walkthroughCard : null}
        </Fragment>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

function MessageRow({
  message,
  onNavigate,
  onRunAction,
  candidateResult,
  onOrderDomain,
}: {
  message: ChatMessage
  onNavigate: (navigation: NavigationSuggestion) => void
  onRunAction: (action: AssistantAction) => void
  candidateResult: DomainSuggestionResult | null
  onOrderDomain?: (path: string) => void
}) {
  const isUser = message.role === 'user'
  const isStreaming = message.status === 'streaming'

  return (
    <div className={isUser ? 'flex min-w-0 flex-col items-end gap-1' : 'flex min-w-0 flex-col items-start gap-1'}>
      <span className="sr-only">{isUser ? USER_MESSAGE_ROLE_LABEL : ASSISTANT_MESSAGE_ROLE_LABEL}</span>
      {/*
       * `break-words` on the bubble: `whitespace-pre-wrap` alone only wraps at
       * existing break opportunities, so a long unbroken token (a URL-ish
       * string, a run of ASCII service names, a doc title) rendered past the
       * bubble's rounded background instead of wrapping inside it.
       */}
      <div
        className={
          isUser
            ? 'max-w-[85%] min-w-0 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground shadow-soft'
            : 'max-w-[85%] min-w-0 rounded-xl bg-card px-3 py-2 text-sm text-card-foreground shadow-soft'
        }
      >
        <p className="break-words whitespace-pre-wrap" aria-hidden={isStreaming ? true : undefined}>
          {message.content}
        </p>
      </div>
      {message.status === 'pending' ? (
        <p className="text-xs text-muted-foreground">{MESSAGE_STATUS_PENDING_HINT}</p>
      ) : null}
      {isStreaming ? (
        <p className="text-xs text-muted-foreground" aria-hidden="true">
          {MESSAGE_STREAMING_HINT}
        </p>
      ) : null}
      {message.status === 'failed' ? (
        <p className="text-xs text-muted-foreground">{MESSAGE_STATUS_FAILED_HINT}</p>
      ) : null}
      {message.navigation ? <NavigationCard navigation={message.navigation} onNavigate={onNavigate} /> : null}
      {message.actions && message.actions.length > 0 ? (
        <QuickActions actions={message.actions} onRun={onRunAction} />
      ) : null}
      {candidateResult && onOrderDomain ? (
        <DomainCandidateList result={candidateResult} onOrder={onOrderDomain} />
      ) : null}
    </div>
  )
}
