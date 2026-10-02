/**
 * zod validation for the AI's parsed decision (spec browser-ai.md §11.4).
 * Every LLM response passes through this before any UI or navigation acts on
 * it - `intent`/`routeId` are restricted to the statically-derived allowlists
 * (`ALLOWED_INTENT_IDS`/`ALLOWED_ROUTE_IDS`), so a hallucinated or injected
 * value simply fails validation rather than reaching the router.
 */
import { z } from 'zod'
import { ALLOWED_INTENT_IDS } from './routing/playbooks'
import { ALLOWED_ROUTE_IDS } from './routing/routeManifest'
import type { AssistantDecision } from './types'

export const decisionSchema = z.object({
  intent: z.enum(ALLOWED_INTENT_IDS),
  reply: z.string().min(1).max(1000),
  // enabled: true の RouteId のみ許可（disabled/unknown ルートは受け付けない）。
  routeId: z.enum(ALLOWED_ROUTE_IDS).nullable(),
  slots: z.record(z.string().max(32), z.string().max(64)),
  confidence: z.number().min(0).max(1),
  needsClarification: z.boolean(),
})

export type DecisionInput = z.input<typeof decisionSchema>

/** §11.5: the caller shows the fixed validation-failure message on `null`. */
export function validateDecision(candidate: unknown): AssistantDecision | null {
  const result = decisionSchema.safeParse(candidate)
  return result.success ? result.data : null
}
