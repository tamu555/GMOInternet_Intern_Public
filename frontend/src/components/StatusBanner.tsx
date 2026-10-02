import type { ReactNode } from 'react'
import { CircleCheck, Info, OctagonAlert } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

export type BannerTone = 'error' | 'info' | 'success'

const TONE_ICONS = {
  error: OctagonAlert,
  info: Info,
  success: CircleCheck,
} as const

/**
 * Form-level message. role="alert" for errors so screen readers announce the
 * failure without the user having to hunt for it. Wraps shadcn Alert — pages
 * must keep using this component instead of inlining Alerts.
 */
export function StatusBanner({
  tone,
  children,
  action,
}: {
  tone: BannerTone
  children: ReactNode
  action?: ReactNode
}) {
  const Icon = TONE_ICONS[tone]

  return (
    <Alert
      role={tone === 'error' ? 'alert' : 'status'}
      variant={tone === 'error' ? 'destructive' : 'default'}
      className={cn(
        'flex items-center gap-3 px-3.5 py-2.5',
        tone === 'error' && 'border-destructive/30 bg-destructive/5',
        tone === 'success' && 'border-primary/30 bg-accent [&>svg]:text-primary',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <AlertDescription
        className={cn('min-w-0 flex-1 leading-relaxed', tone === 'success' && 'text-accent-foreground')}
      >
        {children}
      </AlertDescription>
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </Alert>
  )
}
