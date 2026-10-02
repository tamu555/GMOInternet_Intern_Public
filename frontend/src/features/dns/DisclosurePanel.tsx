/**
 * 既定の読み筋から外した内容を「押せば読める」形で残すための開閉部。
 *
 * 専門用語（DNS・ネームサーバー・レコード）は消さない。ただし初心者が
 * 設定を終えるのに読む必要はない。既定は閉じ、開いた人にだけ見せる（§1.4）。
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

export function DisclosurePanel({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    // 背景色は敷かない — この部品は grass-1 の帯の上にも白いカードの上にも
    // 置かれるので、どちらか一方に合わせると片方で溶ける。細い区切り線で分ける。
    <div className="border-t border-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-[13px] font-bold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1">{label}</span>
        {open ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {open ? <div className="mt-2 flex flex-col gap-2 text-[13px] leading-relaxed">{children}</div> : null}
    </div>
  )
}
