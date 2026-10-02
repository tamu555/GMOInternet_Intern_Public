/**
 * Curated external documentation links and the search-query fallback
 * (design contract §5, spec browser-ai.md §32). `DocSourceCard` is the ONLY
 * component in this feature permitted to render an external `<a href>` -
 * its `href` always comes straight from the caller-supplied
 * `AssistantDocSource` (the compile-time `docs/docSources.ts` registry), and
 * `SearchQueryCard`'s `href` is always built by `searchUrlForQuery()` from an
 * app-built query string. Neither ever reads anything the LLM wrote.
 */
import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  COPY_SEARCH_QUERY_BUTTON_LABEL,
  EXTERNAL_LINK_DISCLAIMER,
  EXTERNAL_SITE_OPEN_NOTICE,
  externalDestinationNote,
  runWebSearchActionLabel,
  SEARCH_QUERY_COPIED_LABEL,
  SEARCH_QUERY_HEADING,
} from './assistantMessages'
import { searchUrlForQuery, SEARCH_ENGINE_NAME } from './docs/docResolver'
import type { AssistantDocSource } from './docs/docSources'

/** Shared by both cards below: names the destination host and states the external-site note BEFORE the click (§5.1/§5.2 transparency requirement). */
function ExternalDestinationNote({ hostname }: { hostname: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {externalDestinationNote(hostname)}
      {' - '}
      {EXTERNAL_SITE_OPEN_NOTICE}. {EXTERNAL_LINK_DISCLAIMER}
    </p>
  )
}

export interface DocSourceCardProps {
  source: AssistantDocSource
}

export function DocSourceCard({ source }: DocSourceCardProps) {
  return (
    <div className="flex w-full max-w-sm min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="min-w-0 font-heading text-sm font-semibold break-words">{source.title}</p>
        {source.language === 'en' ? <Badge variant="outline">EN</Badge> : null}
      </div>
      <p className="text-[13px] break-words text-muted-foreground">{source.publisher}</p>
      <ExternalDestinationNote hostname={source.hostname} />
      {/*
       * `h-auto whitespace-normal break-words` overrides three `buttonVariants`
       * base classes (`h-8`, `whitespace-nowrap`, `shrink-0`) that assume a
       * short label. A doc `title` is a full Japanese sentence - e.g.
       * 「さくらのレンタルサーバ: ドメインのゾーン情報（DNSレコード）を編集する手順」 - and with
       * `whitespace-nowrap` it rendered as one unbroken line that overflowed
       * this card and the chat column around it (a real browser report). The
       * link must wrap like the prose above it.
       */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="h-auto w-fit max-w-full py-1.5 text-left break-words whitespace-normal"
      >
        {/*
         * §5.1/§9.3: this is the only place in the feature where `href` is
         * ever set from something outside app-owned static data - and even
         * here it is `source.url`, a field of the compile-time
         * `AssistantDocSource` this component received as a prop, never a
         * string the model produced or a URL assembled at runtime.
         */}
        <a href={source.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden="true" />
          {source.title}
        </a>
      </Button>
    </div>
  )
}

export interface SearchQueryCardProps {
  query: string
}

export function SearchQueryCard({ query }: SearchQueryCardProps) {
  const [copied, setCopied] = useState(false)
  const url = searchUrlForQuery(query)
  const hostname = new URL(url).hostname

  async function handleCopy(): Promise<void> {
    try {
      // jsdom (and any insecure/non-HTTPS context) has no `navigator.clipboard`
      // - copying is a convenience only (the query text below is already
      // visible and selectable), so a missing/rejecting Clipboard API is
      // silently ignored rather than surfaced as an error.
      await navigator.clipboard.writeText(query)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // See above - no-op on purpose.
    }
  }

  return (
    <div className="flex w-full max-w-sm min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card p-3 text-sm">
      <p className="font-heading text-sm font-semibold">{SEARCH_QUERY_HEADING}</p>
      <p className="rounded-md bg-muted px-2 py-1.5 font-mono text-[13px] break-words select-all">{query}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
          <Copy aria-hidden="true" />
          {copied ? SEARCH_QUERY_COPIED_LABEL : COPY_SEARCH_QUERY_BUTTON_LABEL}
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" />
            {runWebSearchActionLabel(SEARCH_ENGINE_NAME)}
          </a>
        </Button>
      </div>
      <ExternalDestinationNote hostname={hostname} />
    </div>
  )
}
