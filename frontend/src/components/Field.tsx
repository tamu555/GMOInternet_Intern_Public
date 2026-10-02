import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

export type FieldRenderProps = {
  controlId: string
  /** Pass to the control's aria-describedby so hint and error are announced. */
  describedBy: string | undefined
}

/**
 * Label + hint + error wrapper. The render prop hands back the ids so every
 * control is wired to its description and its error message.
 */
export function Field({
  label,
  controlId,
  hint,
  error,
  children,
}: {
  label: string
  controlId: string
  hint?: ReactNode
  error?: string
  children: (props: FieldRenderProps) => ReactNode
}) {
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="space-y-2">
      <Label htmlFor={controlId}>{label}</Label>
      {hint ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children({ controlId, describedBy })}
      {error ? (
        <p className="text-[13px] font-medium text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
