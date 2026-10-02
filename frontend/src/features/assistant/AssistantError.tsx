/**
 * Model-load error card (spec browser-ai.md §16). One branch per
 * `ModelErrorKind`; `'load_failed'` and `'timeout'` share the same generic
 * retry message per the wave contract (a per-message generation timeout uses
 * `GENERATION_TIMEOUT_MESSAGE` on the message itself, not this component).
 */
import { AlertTriangle, RefreshCw, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MODEL_LOAD_FAILED_MESSAGE, MODEL_STORAGE_INSUFFICIENT_MESSAGE, MODEL_UNSUPPORTED_MESSAGE, OPEN_EASY_MODE_BUTTON_LABEL, RETRY_BUTTON_LABEL } from './assistantMessages'
import type { ModelErrorKind } from './engine/modelStatus'

export interface AssistantErrorProps {
  errorKind: ModelErrorKind
  onRetry: () => void
}

export function AssistantError({ errorKind, onRetry }: AssistantErrorProps) {
  if (errorKind === 'unsupported') {
    // `warning`, not `destructive`: an unsupported device is a capability
    // limit (§16), not a failure of the app itself - `destructive` stays
    // reserved for the real load-failure branches below.
    return (
      <Alert variant="warning">
        <AlertTriangle aria-hidden="true" />
        <AlertDescription className="flex flex-col gap-3">
          <p>{MODEL_UNSUPPORTED_MESSAGE}</p>
          {/*
           * §16 / §27.1 #6: the one deliberate fixed link in this feature.
           * It bypasses the Route Manifest on purpose - the AI never picks
           * this route itself, so `EASY_MODE` stays `enabled: false` in
           * routeManifest.ts.
           */}
          <Button asChild variant="outline" className="w-fit">
            <Link to="/easy/goal">{OPEN_EASY_MODE_BUTTON_LABEL}</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (errorKind === 'insufficient_storage') {
    // §16: no retry button - insufficient storage does not change by retrying.
    return (
      <Alert variant="destructive">
        <XCircle aria-hidden="true" />
        <AlertDescription>{MODEL_STORAGE_INSUFFICIENT_MESSAGE}</AlertDescription>
      </Alert>
    )
  }

  // 'load_failed' | 'timeout'
  return (
    <Alert variant="destructive">
      <XCircle aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-3">
        <p>{MODEL_LOAD_FAILED_MESSAGE}</p>
        <Button variant="outline" className="w-fit" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {RETRY_BUTTON_LABEL}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
