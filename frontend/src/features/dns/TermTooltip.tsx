/**
 * 専門用語に添える短い言い換え (§6.3.3)。用語そのものは画面から消さず、
 * 点線の下線＋「?」で「押すと説明が出る」ことを示す。
 *
 * TooltipProvider は AppLayout で1度だけマウントされている（DESIGN_SYSTEM.md）。
 * キーボードでもフォーカスで開くよう、トリガは必ず button にする。
 */
import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DNS_TERMS, type DnsTermId } from './dnsGuide'

export function TermTooltip({
  term,
  children,
  className,
}: {
  term: DnsTermId
  /** 省略時は用語名をそのまま表示する。表記を変えたいときだけ渡す。 */
  children?: ReactNode
  className?: string
}) {
  const { label, description } = DNS_TERMS[term]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}とは`}
          className={cn(
            'inline-flex items-center gap-0.5 rounded-sm align-baseline underline decoration-dotted underline-offset-4',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            className,
          )}
        >
          {children ?? label}
          <CircleHelp className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="leading-relaxed">{description}</TooltipContent>
    </Tooltip>
  )
}
