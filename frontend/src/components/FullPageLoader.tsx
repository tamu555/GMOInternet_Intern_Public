import { Loader2 } from 'lucide-react'

export function FullPageLoader({ message }: { message: string }) {
  return (
    <div
      className="m-auto flex min-h-[50vh] w-full flex-col items-center justify-center gap-4"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
