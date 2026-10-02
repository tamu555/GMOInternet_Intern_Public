/**
 * 「大きなカード1枚＝選択肢1つ」の共通ボタン（使いみちの選択・入力方法の選択）。
 *
 * ⚠️ 見出しがそのまま button のアクセシブルネームになる（説明文は本文として
 * 読ませ、aria-describedby にはしない）。文言を変えるときはメッセージ側を直すこと。
 */
import { ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export function ChoiceButton({
  icon: Icon,
  label,
  description,
  badge,
  onClick,
}: {
  icon: LucideIcon
  label: string
  description: string
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex w-full items-center gap-3.5 bg-muted p-4 text-left transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center bg-card text-primary"
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
          {label}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">{description}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
