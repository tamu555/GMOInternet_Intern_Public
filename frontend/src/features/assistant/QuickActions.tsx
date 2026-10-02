/**
 * Quick Action buttons (design contract §3, spec browser-ai.md §30): renders
 * the app-derived `AssistantAction[]` beneath an assistant message. Actions
 * are never chosen by this component - `deriveActions()` (`actions.ts`,
 * owned by another wave) already decided which actions exist, in what order,
 * and capped/deduplicated them (`MAX_ACTIONS_PER_MESSAGE`); this only renders
 * what it is given.
 *
 * Composition (§3: "OPEN_DOC and RUN_WEB_SEARCH render through
 * DocSourceCard-style external links rather than plain buttons"): `SET_SLOT`
 * and `SUGGEST_DOMAINS` only ever start another turn of the normal, guarded
 * pipeline via `onRun` (see `useAssistantChat.runAction`) - they render as a
 * wrapped row of small outline buttons. `OPEN_DOC`/`RUN_WEB_SEARCH` are real
 * external navigations; rendering them as a plain `<button onClick>` would
 * hide the destination until after the click, which is exactly what
 * `DocSourceCard`/`SearchQueryCard` exist to avoid (§5.1/§5.2: hostname and
 * an "opens an external site" note shown BEFORE the click). They render as a
 * separate stack of cards below the button row instead - keyboard-reachable
 * `<a>` elements, not buttons wired to `onRun`.
 */
import { Button } from '@/components/ui/button'
import type { AssistantAction, OpenDocPayload, RunWebSearchPayload } from './actions'
import { DocSourceCard, SearchQueryCard } from './DocSourceCard'
import { findDocSource } from './docs/docSources'

export interface QuickActionsProps {
  actions: readonly AssistantAction[]
  onRun: (action: AssistantAction) => void
  disabled?: boolean
}

export function QuickActions({ actions, onRun, disabled = false }: QuickActionsProps) {
  if (actions.length === 0) return null

  // `START_WALKTHROUGH` joins the button row rather than the card stacks: like
  // `SET_SLOT`/`SUGGEST_DOMAINS` it is an in-app action handled by
  // `runAction`, with no external destination to disclose before the click.
  const buttonActions = actions.filter(
    (action) => action.kind === 'SET_SLOT' || action.kind === 'SUGGEST_DOMAINS' || action.kind === 'START_WALKTHROUGH',
  )
  const docActions = actions.filter((action) => action.kind === 'OPEN_DOC')
  const searchActions = actions.filter((action) => action.kind === 'RUN_WEB_SEARCH')

  return (
    <div className="flex w-full max-w-sm min-w-0 flex-col gap-2">
      {buttonActions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {/*
           * `h-auto whitespace-normal break-words` overrides `buttonVariants`'
           * base `h-8`/`whitespace-nowrap`/`shrink-0`, which assume a short
           * label. Several labels here are whole Japanese phrases built by
           * `actions.ts` (「Webサイトを公開する手順を見ながら進める」,
           * 「さくらのレンタルサーバ」) and must wrap inside this column instead of
           * pushing past its right edge.
           */}
          {buttonActions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => onRun(action)}
              className="h-auto max-w-full py-1.5 text-left break-words whitespace-normal"
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {docActions.map((action) => {
        const payload = action.payload as OpenDocPayload
        const source = findDocSource(payload.docId)
        // Defensive only: every OPEN_DOC action's docId comes from
        // `deriveActions`, which only ever reads ids out of this same
        // registry (`docs/docSources.ts`) - a miss here would mean the
        // registry and `deriveActions` drifted apart, never a runtime/user
        // condition, so this silently skips rendering rather than crashing.
        if (!source) return null
        return <DocSourceCard key={action.id} source={source} />
      })}

      {searchActions.map((action) => {
        const payload = action.payload as RunWebSearchPayload
        return <SearchQueryCard key={action.id} query={payload.query} />
      })}
    </div>
  )
}
