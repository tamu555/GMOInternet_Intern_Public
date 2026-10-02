/**
 * Multi-chat tab strip (spec browser-ai.md §7.5, FR-08). Built on
 * `@/components/ui/tabs`; the per-tab delete affordance is a sibling of
 * `TabsTrigger`, never a descendant - a `<button>` nested inside another
 * interactive `<button>` is invalid HTML, and it would also switch tabs on
 * every delete click since Radix's trigger click handler would fire first.
 */
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  conversationDisplayTitle,
  CONVERSATION_TABS_LABEL,
  DELETE_CONVERSATION_BUTTON_LABEL,
  NEW_CONVERSATION_BUTTON_LABEL,
} from './assistantMessages'
import type { Conversation } from './types'

export interface ConversationTabsProps {
  conversations: readonly Conversation[]
  activeConversationId: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onCreate: () => void
}

export function ConversationTabs({ conversations, activeConversationId, onSelect, onDelete, onCreate }: ConversationTabsProps) {
  return (
    // `min-w-0` on the `Tabs` root too, not only on the scroll container below:
    // THIS element is the grid item (see `AssistantModal`'s
    // `grid-cols-[minmax(0,1fr)]` comment), and a flex/grid item's default
    // `min-width: auto` refuses to shrink below its content. Measured: with the
    // track capped but this element left at `auto`, the strip was still 872px
    // inside a 672px panel. Both the track cap and this floor removal are
    // required; either alone leaves the tabs spilling out of the modal.
    <Tabs value={activeConversationId} onValueChange={onSelect} aria-label={CONVERSATION_TABS_LABEL} className="min-w-0">
      {/*
       * Horizontal scroll instead of wrapping, so a long tab strip never
       * grows the modal itself (§7.5). `overflow-x-auto` alone is not
       * enough here: `DialogContent` (components/ui/dialog.tsx) is
       * `display: grid`, and this div is (through `Tabs`, which is a
       * single-child `flex-col` container for horizontal orientation) the
       * grid item's own flex item. A flex/grid item's default
       * `min-width: auto` refuses to shrink below its content's intrinsic
       * width, so without `min-w-0` this div never actually got narrower
       * than the full tab strip - it grew instead, dragging `Tabs`, the
       * grid, and the dialog itself past `sm:max-w-2xl`. Same failure mode,
       * and same fix, as `WalkthroughStepper`'s own scroll row (§0.4.4
       * 決定35) - see the `min-w-0 flex-1` wrapper around that row in
       * `AssistantModal.tsx`.
       */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        <TabsList className="h-auto shrink-0 flex-nowrap gap-1 bg-transparent p-0">
          {conversations.map((conversation) => {
            const displayTitle = conversationDisplayTitle(conversation.title)
            return (
            <div key={conversation.id} className="flex shrink-0 items-center gap-0.5">
              {/* `TabsTrigger` is an `inline-flex ... justify-center`, so
                  `truncate` on it does nothing: the label is a flex item that
                  overflows and gets centred, which clipped BOTH ends of a long
                  title instead of showing an ellipsis. The label needs its own
                  block-level box, and the trigger needs `min-w-0` so the flex
                  item is allowed to shrink below its content width. `title`
                  keeps the full text reachable on hover. */}
              <TabsTrigger
                value={conversation.id}
                className="min-w-0 rounded-none data-active:bg-accent"
                title={displayTitle}
              >
                <span className="block max-w-[9rem] truncate">{displayTitle}</span>
              </TabsTrigger>
              <button
                type="button"
                aria-label={`${DELETE_CONVERSATION_BUTTON_LABEL}: ${displayTitle}`}
                className="shrink-0 rounded-none p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onDelete(conversation.id)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            )
          })}
        </TabsList>
        <Button variant="ghost" size="icon-xs" aria-label={NEW_CONVERSATION_BUTTON_LABEL} className="shrink-0" onClick={onCreate}>
          <Plus />
        </Button>
      </div>
    </Tabs>
  )
}
