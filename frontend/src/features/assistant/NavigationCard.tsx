/**
 * Navigation Card (spec browser-ai.md §13.1, §10.1): the UI-owned rendering
 * of a validated `NavigationSuggestion` - route title/description come from
 * the Route Manifest, guidance/warnings come from the matching Playbook.
 */
import { AlertTriangle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { NAVIGATION_CARD_WARNINGS_LABEL, navigationCtaLabel } from './assistantMessages'
import { findPlaybook } from './routing/playbooks'
import type { NavigationSuggestion } from './types'

export interface NavigationCardProps {
  navigation: NavigationSuggestion
  onNavigate: (navigation: NavigationSuggestion) => void
}

export function NavigationCard({ navigation, onNavigate }: NavigationCardProps) {
  // `intent` is optional on `NavigationSuggestion` (added by the controller
  // hook wave) - an older/partial suggestion without it still renders the
  // route-only card, just without the guidance/warnings lines.
  const playbook = navigation.intent ? findPlaybook(navigation.intent) : undefined

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="font-heading text-sm font-semibold">{navigation.title}</p>
          <p className="text-[13px] text-muted-foreground">{navigation.description}</p>
        </div>

        {playbook?.guidance ? <p className="text-[13px] text-foreground/80">{playbook.guidance}</p> : null}

        {playbook && playbook.warnings.length > 0 ? (
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>{NAVIGATION_CARD_WARNINGS_LABEL}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {playbook.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end">
          {/*
           * §9.3/§9.4: navigation happens through react-router's navigate(),
           * wired by the controller hook via `onNavigate`. This is a plain
           * Button - never an <a href> - and `navigation.resolvedPath` is
           * intentionally never read here, so it never ends up in a DOM
           * attribute.
           */}
          <Button onClick={() => onNavigate(navigation)}>{navigationCtaLabel(navigation.title)}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
