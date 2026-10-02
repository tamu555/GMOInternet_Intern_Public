/**
 * Modal header (spec browser-ai.md §13.2): the `AssistantModal` title plus
 * the two conversation-wide actions from §7.5 (new conversation / delete
 * every conversation). `ASSISTANT_MODAL_TITLE` is rendered as Radix's
 * `DialogTitle` so `DialogContent` gets its automatic `aria-labelledby`.
 */
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogTitle } from '@/components/ui/dialog'
import { ASSISTANT_MODAL_TITLE, DELETE_ALL_CONVERSATIONS_BUTTON_LABEL, NEW_CONVERSATION_BUTTON_LABEL } from './assistantMessages'

export interface AssistantHeaderProps {
  onNewConversation: () => void
  onDeleteAll: () => void
  canDeleteAll: boolean
}

export function AssistantHeader({ onNewConversation, onDeleteAll, canDeleteAll }: AssistantHeaderProps) {
  return (
    // `pr-9` reserves the corner `DialogContent` renders its own close button
    // into (`absolute top-2 right-2`, `size="icon-sm"` - see components/ui/dialog.tsx);
    // without it the 会話をすべて削除 button slides under the × and the two overlap.
    //
    // ⚠️ `min-w-0` is what makes `flex-wrap` above actually work, and without it
    // the `pr-9` reservation was decorative. `DialogContent` is `display: grid`,
    // so this row is a grid item, and a grid item's default `min-width: auto`
    // sizes it to its own max-content width. The row therefore never became
    // narrower than title + both buttons on one line, so it had no reason to
    // wrap - it simply overflowed the panel instead, and 会話をすべて削除 ran out
    // past the modal's right edge and under the × (visible in the user's own
    // screenshot). Same root cause as the tab strip next to it and as
    // `WalkthroughStepper` before that (§0.4.4 決定35): `overflow`/`flex-wrap`
    // can only act once the box is allowed to be smaller than its content.
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 pr-9">
      {/* `shrink-0` + `whitespace-nowrap`: the title is short and fixed, so it
          must keep its intrinsic width instead of being squeezed (and broken
          mid-word) by the two action buttons next to it. */}
      <DialogTitle className="shrink-0 whitespace-nowrap">{ASSISTANT_MODAL_TITLE}</DialogTitle>
      {/* `ml-auto`: right-aligned when everything fits on one row, and it wraps
          to its own row as a block when the modal is too narrow. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="xs" className="whitespace-nowrap" onClick={onNewConversation}>
          <Plus aria-hidden="true" />
          {NEW_CONVERSATION_BUTTON_LABEL}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          className="whitespace-nowrap"
          disabled={!canDeleteAll}
          onClick={onDeleteAll}
        >
          <Trash2 aria-hidden="true" />
          {DELETE_ALL_CONVERSATIONS_BUTTON_LABEL}
        </Button>
      </div>
    </div>
  )
}
