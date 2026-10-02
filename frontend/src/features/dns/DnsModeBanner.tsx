/**
 * 選んだあとに出す「いま自分は何をしているか」の帯。
 *
 * ⚠️ 前の版はここで DNS の2階層（①ネームサーバー ②レコード）を教えていた。
 * 用語を知らない人にとって、それは「自分が何をしているか」の説明にならない。
 * 帯は平易な言い換えだけを出し、2階層の説明と用語は「くわしく知りたい方へ」の
 * 開閉部へ移す（用語は消さない — §1.4）。
 */
import { Layers } from 'lucide-react'
import {
  JARGON_DISCLOSURE_LABEL,
  MODE_NOW_NS_BODY,
  MODE_NOW_NS_PLAIN,
  MODE_NOW_RECORDS_BODY,
  MODE_NOW_RECORDS_PLAIN,
} from './connectMessages'
import { DisclosurePanel } from './DisclosurePanel'
import { DNS_MODE_HINT, DNS_MODE_NOW_NS, DNS_MODE_NOW_RECORDS } from './dnsMessages'
import type { DnsMode } from './dnsMode'
import { TermTooltip } from './TermTooltip'

export function DnsModeBanner({ mode }: { mode: DnsMode }) {
  const isNs = mode === 'ns'

  return (
    <div className="flex flex-col gap-3 bg-grass-1 p-3.5">
      <div>
        <p className="flex items-start gap-2 text-sm font-bold">
          <Layers aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          {isNs ? MODE_NOW_NS_PLAIN : MODE_NOW_RECORDS_PLAIN}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {isNs ? MODE_NOW_NS_BODY : MODE_NOW_RECORDS_BODY}
        </p>
      </div>

      <DisclosurePanel label={JARGON_DISCLOSURE_LABEL}>
        <p>{isNs ? DNS_MODE_NOW_NS : DNS_MODE_NOW_RECORDS}</p>
        <p className="text-muted-foreground">{DNS_MODE_HINT}</p>
        {/* 用語は消さず、押すと短い言い換えが出る形で残す（§1.2）。 */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-muted-foreground">用語の意味:</span>
          <TermTooltip term="dns" className="font-semibold text-foreground" />
          <TermTooltip term={isNs ? 'nameserver' : 'record'} className="font-semibold text-foreground" />
        </p>
      </DisclosurePanel>
    </div>
  )
}
