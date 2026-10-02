/**
 * Model-preparing card (spec browser-ai.md §6.4, §6.4.2, §17.2, §17.4).
 * Renders per `ModelState.status`; the modal itself decides what (if
 * anything) to show for every other status (`READY`, `UNSUPPORTED`, `ERROR`).
 */
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  CONSENT_TO_DOWNLOAD_BUTTON_LABEL,
  DOWNLOAD_IN_PROGRESS_ELSEWHERE_MESSAGE,
  MODEL_PREPARING_AUTO_START_NOTE,
  MODEL_PREPARING_FIRST_TIME_NOTE,
  MODEL_PREPARING_TITLE,
  MODEL_PROGRESS_LABEL,
  SLOW_CONNECTION_CONSENT_MESSAGE,
} from './assistantMessages'
import type { ModelState } from './store/modelStore'

export interface ModelLoadingProps {
  state: ModelState
  onConsent: () => void
}

const PREPARING_STATUSES = new Set(['NOT_STARTED', 'CHECKING', 'DOWNLOADING', 'INITIALIZING'])

export function ModelLoading({ state, onConsent }: ModelLoadingProps) {
  if (state.status === 'AWAITING_CONSENT') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm text-foreground">{SLOW_CONNECTION_CONSENT_MESSAGE}</p>
        <Button onClick={onConsent}>{CONSENT_TO_DOWNLOAD_BUTTON_LABEL}</Button>
      </div>
    )
  }

  if (!PREPARING_STATUSES.has(state.status)) return null

  const percent = Math.round(state.progress * 100)

  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center" aria-live="polite">
      <p className="font-heading text-base font-semibold">{MODEL_PREPARING_TITLE}</p>
      {state.lockedByOtherTab ? (
        <p className="text-sm text-muted-foreground">{DOWNLOAD_IN_PROGRESS_ELSEWHERE_MESSAGE}</p>
      ) : (
        <div className="w-full max-w-[220px] space-y-1.5">
          <Progress value={percent} aria-label={MODEL_PROGRESS_LABEL} />
          <p className="text-sm text-muted-foreground">{percent}%</p>
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">{MODEL_PREPARING_FIRST_TIME_NOTE}</p>
      <p className="text-[13px] text-muted-foreground">{MODEL_PREPARING_AUTO_START_NOTE}</p>
    </div>
  )
}
