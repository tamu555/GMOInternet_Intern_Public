/**
 * Similar-domain suggestion cards (spec §6.2.4). Every candidate here has
 * already been re-checked against the search API by `suggestionEngine.ts` -
 * this component only renders confirmed results, never a raw guess.
 */
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { CandidateSuggestion } from './suggestionEngine'
import { getTldMeta } from './tldData'

export function SuggestionList({ candidates }: { candidates: CandidateSuggestion[] }) {
  if (candidates.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        類似候補も見つかりませんでした。別の文字列でお試しください。
      </p>
    )
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {candidates.map((candidate) => {
        const meta = getTldMeta(candidate.tld)
        return (
          <li key={candidate.domain}>
            <Card size="sm" className="h-full">
              <CardContent className="flex h-full flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-medium break-all">{candidate.domain}</span>
                  <Badge className="shrink-0">空きあり</Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">{candidate.reason}</p>
                {meta?.caveat ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">{meta.caveat}</p>
                ) : null}
                <Button asChild size="sm" className="mt-auto self-start">
                  <Link to={`/domains/new?domain=${encodeURIComponent(candidate.domain)}`}>申し込む</Link>
                </Button>
              </CardContent>
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
