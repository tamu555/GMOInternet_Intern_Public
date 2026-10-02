/**
 * Confirmation gate in front of the header's ログアウト button - a stray click
 * used to log the user out immediately with no way back. Follows the same
 * `Dialog`/`DialogHeader`/`DialogFooter` split every other confirm dialog in
 * this codebase uses (`RetireDialog.tsx`'s "confirm-delete" step,
 * `PasteDialog.tsx`), not `AssistantModal`'s bespoke layout - this dialog has
 * none of `AssistantModal`'s reasons (no Radix `DialogTrigger` to hand focus
 * back to, no oversized body) to deviate from the shared component.
 *
 * Radix's `Dialog.Root` already gives the shared `DialogContent` everything
 * the team's a11y checklist asks for: `role="dialog"`, `aria-labelledby`
 * wired to `DialogTitle`, focus trapped/restored on open+close, and
 * Escape/backdrop-click both routed through `onOpenChange(false)` - so none
 * of that needs to be re-implemented here (contrast `AssistantModal`, which
 * explicitly adds `aria-modal` only because it has no `DialogTrigger` of its
 * own; this dialog's trigger IS the header button, so Radix's own detection
 * already applies it).
 */
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type LogoutConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs the real logout. The caller is expected to close the dialog itself before/around this call. */
  onConfirm: () => void
}

export function LogoutConfirmDialog({ open, onOpenChange, onConfirm }: LogoutConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>ログアウトしますか？</DialogTitle>
          <DialogDescription>
            もう一度ログインするまで、ログインが必要な画面にはアクセスできなくなります。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            ログアウト
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
