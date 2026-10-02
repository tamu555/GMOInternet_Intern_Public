/**
 * §8.4 domain-candidate results (design contract §4.2, spec browser-ai.md
 * §31.2): rule-based candidates rendered first, AI-proposed candidates
 * second and clearly separated - this ordering is a spec requirement (the
 * rule-based engine is the core, AI is secondary), not a styling choice.
 *
 * Every candidate rendered here already passed `verifyCandidates()`
 * (`suggest/domainSuggestion.ts`), so every one of them IS available - there
 * is no per-candidate "taken"/"unknown" state to render, only the
 * list-level `degraded` flag for when the availability check itself could
 * not be completed (never a fabricated availability claim, FR-18).
 */
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  AI_SUGGESTED_CANDIDATES_HEADING,
  DOMAIN_AVAILABILITY_UNKNOWN_LABEL,
  DOMAIN_AVAILABLE_LABEL,
  DOMAIN_CANDIDATE_NOT_ORDERABLE_NOTE,
  DOMAIN_CANDIDATE_ORDER_BUTTON_LABEL,
  RULE_BASED_CANDIDATES_HEADING,
  SUGGEST_DOMAINS_FAILED_MESSAGE,
} from './assistantMessages'
import type { AssistantDomainCandidate, DomainSuggestionResult } from './suggest/domainSuggestion'
import { orderPathForDomain } from './suggest/orderPath'
import { formatYen } from '../domains/tldData'

export interface DomainCandidateListProps {
  result: DomainSuggestionResult
  onOrder: (path: string) => void
}

export function DomainCandidateList({ result, onOrder }: DomainCandidateListProps) {
  // §31.2/FR-18: never present a partially- or un-verified list as available -
  // when the availability check itself failed, show only the honest failure
  // copy and no candidates at all.
  if (result.degraded) {
    return (
      <Alert variant="warning" className="w-full max-w-sm">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>{DOMAIN_AVAILABILITY_UNKNOWN_LABEL}</AlertTitle>
        <AlertDescription>{SUGGEST_DOMAINS_FAILED_MESSAGE}</AlertDescription>
      </Alert>
    )
  }

  if (result.ruleCandidates.length === 0 && result.aiCandidates.length === 0) return null

  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      {result.ruleCandidates.length > 0 ? (
        <CandidateSection heading={RULE_BASED_CANDIDATES_HEADING} candidates={result.ruleCandidates} onOrder={onOrder} />
      ) : null}
      {result.aiCandidates.length > 0 ? (
        <CandidateSection heading={AI_SUGGESTED_CANDIDATES_HEADING} candidates={result.aiCandidates} onOrder={onOrder} />
      ) : null}
    </div>
  )
}

function CandidateSection({
  heading,
  candidates,
  onOrder,
}: {
  heading: string
  candidates: readonly AssistantDomainCandidate[]
  onOrder: (path: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-heading text-sm font-semibold">{heading}</p>
      {candidates.map((candidate) => (
        <CandidateCard key={candidate.domain} candidate={candidate} onOrder={onOrder} />
      ))}
    </div>
  )
}

function CandidateCard({
  candidate,
  onOrder,
}: {
  candidate: AssistantDomainCandidate
  onOrder: (path: string) => void
}) {
  // §31.2: `candidate.orderable === false` (the TLD has no pricing entry)
  // must render with NO 申し込む button at all - `orderPathForDomain` is only
  // consulted to build the actual path once `orderable` has already gated
  // whether a button appears, never to decide the gate itself.
  const orderPath = candidate.orderable ? orderPathForDomain(candidate.domain) : null

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm">{candidate.domain}</span>
          <Badge variant="secondary">{DOMAIN_AVAILABLE_LABEL}</Badge>
        </div>
        {candidate.firstYearYen !== null ? (
          <p className="text-[13px] text-muted-foreground">{formatYen(candidate.firstYearYen)}〜</p>
        ) : null}
        {/* §31.2 mandatory: the .dev/.app HTTPS-required notice (registrar-spec-draft §6.2.4). */}
        {candidate.caveat ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertDescription>{candidate.caveat}</AlertDescription>
          </Alert>
        ) : null}
        {candidate.reason ? <p className="text-[13px] text-foreground/80">{candidate.reason}</p> : null}
        <div className="flex justify-end">
          {orderPath ? (
            <Button size="sm" onClick={() => onOrder(orderPath)}>
              {DOMAIN_CANDIDATE_ORDER_BUTTON_LABEL}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{DOMAIN_CANDIDATE_NOT_ORDERABLE_NOTE}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
