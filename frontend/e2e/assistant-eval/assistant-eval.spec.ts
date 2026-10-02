/**
 * §21.3/§21.4 LLM-quality evaluation: drives the real in-browser assistant
 * (real WebLLM inference, real WebGPU, no mocked engine) through all 500
 * cases in `dataset.json` and machine-judges the release gate (`gate.ts`).
 *
 * *** REQUIRES A REAL GPU - NOT PART OF `npm test` ***
 * This spec downloads ~350 MB (the Qwen3-0.6B weights + WASM, §5.1) into a
 * persisted Chromium profile the first time it runs, then drives up to 500
 * real chat turns through a real model - it can take on the order of an
 * hour or more end-to-end (see `playwright.config.ts`'s `PER_TEST_TIMEOUT_MS`
 * for the budget breakdown). It is excluded from the normal `vitest`
 * suite (`npm test`) by construction: vitest's default `include` only picks
 * up `*.test.ts(x)`, never `*.spec.ts` (see `vite.config.ts`, unmodified by
 * this feature). Run it explicitly with `npm run eval:assistant` on a
 * machine with a real GPU - see `README.md` in this directory.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import { CHROMIUM_LAUNCH_ARGS, PERSISTENT_USER_DATA_DIR } from '../../playwright.config'
import { computeMetrics, evaluateGate, type CaseOutcome } from './gate'

// Reaching into `src/` with relative imports (not the `@/` alias): Playwright
// Test's own TypeScript loader resolves `paths` from whichever tsconfig it
// picks up by directory walk, and this repo's root `tsconfig.json` is a
// solution-style file (`references` only) - relative imports sidestep that
// ambiguity entirely and work identically to how `vite`/`vitest` resolve them.
import {
  ASSISTANT_LAUNCHER_BUTTON_LABEL,
  ASSISTANT_MESSAGE_ROLE_LABEL,
  ASSISTANT_MODAL_TITLE,
  CHAT_INPUT_LABEL,
  CHAT_INPUT_SEND_BUTTON_LABEL,
  CONSENT_TO_DOWNLOAD_BUTTON_LABEL,
  DECISION_VALIDATION_FAILED_MESSAGE,
  GENERATION_TIMEOUT_MESSAGE,
  MESSAGE_STREAMING_HINT,
  MODEL_LOAD_FAILED_MESSAGE,
  MODEL_PREPARING_TITLE,
  MODEL_STORAGE_INSUFFICIENT_MESSAGE,
  MODEL_UNSUPPORTED_MESSAGE,
  NEW_CONVERSATION_BUTTON_LABEL,
  OUT_OF_SCOPE_MESSAGE,
  SUSPICIOUS_INPUT_MESSAGE,
} from '../../src/features/assistant/assistantMessages'
import { ASSISTANT_CONFIG } from '../../src/features/assistant/config/assistantConfig'
import { resolveRoutePath, routeIdForPath } from '../../src/features/assistant/routing/manifestResolver'
import type { IntentId } from '../../src/features/assistant/routing/playbooks'
import { ASSISTANT_ROUTES, findRoute, type RouteId } from '../../src/features/assistant/routing/routeManifest'
import { maskDnsValueLines } from '../../src/features/assistant/security/outputGuard'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATASET_PATH = path.join(HERE, 'dataset.json')
const SCHEMA_PATH = path.join(HERE, 'dataset.schema.json')
/**
 * Deliberately NOT `report.json` - `playwright.config.ts`'s own JSON
 * reporter (`reporter: [['list'], ['json', { outputFile:
 * 'e2e/assistant-eval/report.json' }]]`, written per the task brief
 * verbatim) writes Playwright's generic pass/fail/timings report to that
 * exact path when the run finishes, which would silently clobber this
 * richer `{ metrics, gate, outcomes, ... }` report if both used the same
 * filename (the reporter flushes after the test body returns, so it would
 * always overwrite whatever this file wrote last). Keeping this one at a
 * different name avoids a two-writers-one-file race entirely; see the
 * wave report / README for this explicitly-flagged deviation from the
 * brief's file list.
 */
const GATE_REPORT_PATH = path.join(HERE, 'gate-report.json')

// ---------------------------------------------------------------------------
// Dataset types + hand-rolled schema validation (no ajv/zod dependency added
// to this harness - dataset.schema.json is the source of truth for the
// enums/limits below, read at runtime so they can never drift out of sync).
// ---------------------------------------------------------------------------

type DatasetCategory = 'in_scope' | 'clarification' | 'explanation' | 'out_of_scope' | 'injection'

interface DatasetCase {
  id: string
  utterance: string
  category: DatasetCategory
  expectedIntent: IntentId
  expectedRouteId: RouteId | null
  expectedSlots: Record<string, string>
  expectNavigationCard: boolean
  expectClarification: boolean
  pageContext: { routeId: RouteId | null; hasSelectedDomain: boolean }
  notes: string
  blocked?: true
}

interface Dataset {
  version: 1
  assistantVersion: string
  cases: DatasetCase[]
}

/** Only the parts of dataset.schema.json this validator actually reads. */
interface RawDatasetSchema {
  properties: { cases: { minItems: number; maxItems: number } }
  $defs: {
    intentId: { enum: string[] }
    routeId: { enum: (string | null)[] }
    connectWebsiteProvider: { enum: string[] }
    setupEmailProvider: { enum: string[] }
    case: { required: string[]; properties: { category: { enum: string[] }; id: { pattern: string } } }
  }
}

type ValidationResult = { ok: true; cases: DatasetCase[] } | { ok: false; errors: string[] }

/**
 * Structural re-check of `dataset.json` against `dataset.schema.json`'s
 * constraints (§21.3: "fails fast if the shape drifts"). Not a generic JSON
 * Schema evaluator - it hard-codes exactly the shape `dataset.schema.json`
 * currently describes, but reads every enum/pattern/limit FROM the schema
 * object at runtime rather than duplicating the literal values, so the two
 * files cannot silently diverge on the actual allowed values.
 */
function validateDataset(raw: unknown, schema: RawDatasetSchema): ValidationResult {
  const errors: string[] = []

  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['dataset root is not an object'] }
  const data = raw as Record<string, unknown>

  if (data.version !== 1) errors.push(`version must be 1, got ${JSON.stringify(data.version)}`)
  if (typeof data.assistantVersion !== 'string' || data.assistantVersion.length === 0) {
    errors.push('assistantVersion must be a non-empty string')
  }

  const cases = data.cases
  if (!Array.isArray(cases)) return { ok: false, errors: [...errors, 'cases must be an array'] }

  const { minItems, maxItems } = schema.properties.cases
  if (cases.length < minItems || cases.length > maxItems) {
    errors.push(`cases.length must be between ${minItems} and ${maxItems}, got ${cases.length}`)
  }

  const requiredFields = schema.$defs.case.required
  const categoryEnum = new Set(schema.$defs.case.properties.category.enum)
  const idPattern = new RegExp(schema.$defs.case.properties.id.pattern)
  const intentEnum = new Set(schema.$defs.intentId.enum)
  const routeEnum = new Set(schema.$defs.routeId.enum) // includes null
  const connectWebsiteProviders = new Set(schema.$defs.connectWebsiteProvider.enum)
  const setupEmailProviders = new Set(schema.$defs.setupEmailProvider.enum)

  cases.forEach((entry, index) => {
    const prefix = `cases[${index}]`
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${prefix} is not an object`)
      return
    }
    const c = entry as Record<string, unknown>

    for (const field of requiredFields) {
      if (!(field in c)) errors.push(`${prefix} missing required field "${field}"`)
    }
    if (typeof c.id !== 'string' || !idPattern.test(c.id)) errors.push(`${prefix}.id invalid: ${JSON.stringify(c.id)}`)
    if (typeof c.utterance !== 'string' || c.utterance.length === 0) {
      errors.push(`${prefix}.utterance must be a non-empty string`)
    }
    if (typeof c.category !== 'string' || !categoryEnum.has(c.category)) {
      errors.push(`${prefix}.category invalid: ${JSON.stringify(c.category)}`)
    }
    if (typeof c.expectedIntent !== 'string' || !intentEnum.has(c.expectedIntent)) {
      errors.push(`${prefix}.expectedIntent invalid: ${JSON.stringify(c.expectedIntent)}`)
    }
    if (!(c.expectedRouteId === null || (typeof c.expectedRouteId === 'string' && routeEnum.has(c.expectedRouteId)))) {
      errors.push(`${prefix}.expectedRouteId invalid: ${JSON.stringify(c.expectedRouteId)}`)
    }
    if (typeof c.expectNavigationCard !== 'boolean') errors.push(`${prefix}.expectNavigationCard must be boolean`)
    if (typeof c.expectClarification !== 'boolean') errors.push(`${prefix}.expectClarification must be boolean`)
    if (typeof c.notes !== 'string') errors.push(`${prefix}.notes must be a string`)

    const slots = c.expectedSlots
    if (typeof slots !== 'object' || slots === null || Array.isArray(slots)) {
      errors.push(`${prefix}.expectedSlots must be an object`)
    } else {
      const slotRecord = slots as Record<string, unknown>
      const keys = Object.keys(slotRecord)
      if (c.expectedIntent === 'CONNECT_WEBSITE') {
        if (keys.some((key) => key !== 'provider')) errors.push(`${prefix}.expectedSlots has keys other than "provider"`)
        if ('provider' in slotRecord && !connectWebsiteProviders.has(slotRecord.provider as string)) {
          errors.push(`${prefix}.expectedSlots.provider invalid for CONNECT_WEBSITE: ${JSON.stringify(slotRecord.provider)}`)
        }
      } else if (c.expectedIntent === 'SETUP_EMAIL') {
        if (keys.some((key) => key !== 'provider')) errors.push(`${prefix}.expectedSlots has keys other than "provider"`)
        if ('provider' in slotRecord && !setupEmailProviders.has(slotRecord.provider as string)) {
          errors.push(`${prefix}.expectedSlots.provider invalid for SETUP_EMAIL: ${JSON.stringify(slotRecord.provider)}`)
        }
      } else if (keys.length > 0) {
        errors.push(`${prefix}.expectedSlots must be empty when expectedIntent is ${String(c.expectedIntent)}`)
      }
    }

    const pageContext = c.pageContext
    if (typeof pageContext !== 'object' || pageContext === null) {
      errors.push(`${prefix}.pageContext must be an object`)
    } else {
      const pc = pageContext as Record<string, unknown>
      if (!(pc.routeId === null || (typeof pc.routeId === 'string' && routeEnum.has(pc.routeId)))) {
        errors.push(`${prefix}.pageContext.routeId invalid: ${JSON.stringify(pc.routeId)}`)
      }
      if (typeof pc.hasSelectedDomain !== 'boolean') errors.push(`${prefix}.pageContext.hasSelectedDomain must be boolean`)
    }

    if (c.expectedRouteId === null && c.expectNavigationCard !== false) {
      errors.push(`${prefix}: expectedRouteId is null but expectNavigationCard is not false`)
    }
    if (c.expectClarification === true && c.expectNavigationCard !== false) {
      errors.push(`${prefix}: expectClarification is true but expectNavigationCard is not false`)
    }
    if (c.category !== 'injection' && 'blocked' in c) {
      errors.push(`${prefix}: "blocked" is only allowed when category is "injection"`)
    }
    if ('blocked' in c && c.blocked !== true) errors.push(`${prefix}.blocked must be true when present`)
  })

  return errors.length === 0 ? { ok: true, cases: cases as DatasetCase[] } : { ok: false, errors }
}

function loadDatasetAndSchema(): { dataset: Dataset; schema: RawDatasetSchema } {
  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as RawDatasetSchema
  return { dataset, schema }
}

// ---------------------------------------------------------------------------
// Fixed browser context: persistent profile (so the IndexedDB model cache
// survives between `npm run eval:assistant` invocations, §6.5) + the same
// WebGPU launch flags as playwright.config.ts (see that file's comment on
// why `use.launchOptions` alone cannot reach a persistent context).
// ---------------------------------------------------------------------------

const test = base.extend<{ context: BrowserContext; page: Page }>({
  // Playwright's fixture callback conventionally names its second parameter
  // `use` - renamed to `provideFixtureValue` here because oxlint's
  // `react-hooks/rules-of-hooks` treats ANY call to a function literally
  // named `use` as React's `use()` hook (a naming heuristic, not an actual
  // hook call - this file has no React component in it) and errors on it.
  // The parameter name has no semantic meaning to Playwright itself.
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the (possibly empty) deps object as the first param.
  context: async ({}, provideFixtureValue) => {
    const context = await chromium.launchPersistentContext(PERSISTENT_USER_DATA_DIR, {
      headless: false,
      args: [...CHROMIUM_LAUNCH_ARGS],
    })
    try {
      await provideFixtureValue(context)
    } finally {
      await context.close()
    }
  },
  page: async ({ context }, provideFixtureValue) => {
    // launchPersistentContext already opens one blank page - reuse it
    // instead of opening a second tab via the default `page` fixture logic.
    const page = context.pages()[0] ?? (await context.newPage())
    await provideFixtureValue(page)
  },
})

// ---------------------------------------------------------------------------
// Fixed sample domain / pages used to set up each case's PageContext (§13.6).
// This harness never authenticates through a real Firebase Auth + Functions
// emulator (none is started by `webServer`, see README "Honest limitations")
// - it fakes the Cookie-session check instead (`GET /api/session/me`, the
// sole authority `AuthProvider.tsx` relies on) so `RequireAuth`-protected
// pages render without a real backend. This never touches `AssistantEngine`,
// `AssistantDecision`, or any assistant-owned code path - only the app's
// existing auth guard - so it does not change what is being evaluated.
// ---------------------------------------------------------------------------

const FIXED_SAMPLE_DOMAIN = 'eval-sample-domain.test'
/** Any authenticated, Manifest-untracked route - used for `pageContext.routeId === null` cases so `routeIdForPath()` genuinely returns null there. */
const NO_MANIFEST_ROUTE_PATH = '/dashboard'
const FAKE_AUTH_USER = { id: 'assistant-eval-harness', email: 'assistant-eval@example.test', displayName: 'Assistant Eval Harness' }

interface ResolvedPageContext {
  path: string
  requiresAuthMock: boolean
}

/** Resolves a dataset case's `pageContext` to a concrete path to `page.goto()` before opening the assistant. */
function pathForPageContext(pageContext: DatasetCase['pageContext']): ResolvedPageContext {
  // LOGIN/SIGNUP are guest-only (`RequireGuest`) - an authenticated session
  // would bounce away from them, so these two must never carry the fake
  // session (only 7/500 cases use either, per the dataset).
  if (pageContext.routeId === 'LOGIN') return { path: '/login', requiresAuthMock: false }
  if (pageContext.routeId === 'SIGNUP') return { path: '/signup', requiresAuthMock: false }
  if (pageContext.routeId === null) return { path: NO_MANIFEST_ROUTE_PATH, requiresAuthMock: true }

  const route = findRoute(pageContext.routeId)
  if (!route) return { path: '/', requiresAuthMock: false }

  const domain = pageContext.hasSelectedDomain ? FIXED_SAMPLE_DOMAIN : undefined
  const resolved = resolveRoutePath(route, { routeId: route.id, ...(domain ? { domain } : {}) })
  // dataset.json always pairs a requiresDomain route with hasSelectedDomain:
  // true (verified against the current 500-case dataset), so `resolved` is
  // never actually null here - the DOMAIN_LIST fallback only guards against
  // a future dataset case breaking that pairing.
  return { path: resolved ?? '/mypage', requiresAuthMock: route.requiresAuth }
}

interface CaseGroup {
  path: string
  requiresAuthMock: boolean
  cases: DatasetCase[]
}

/**
 * Groups cases by their resolved page path so the harness only pays for a
 * `page.goto()` (and the model reload-from-cache it forces, see below) once
 * per distinct page, not once per case - the 500-case dataset resolves to
 * only 8 distinct paths in practice.
 */
function groupCasesByPage(cases: readonly DatasetCase[]): CaseGroup[] {
  const groups = new Map<string, CaseGroup>()
  for (const datasetCase of cases) {
    const resolved = pathForPageContext(datasetCase.pageContext)
    const existing = groups.get(resolved.path)
    if (existing) {
      existing.cases.push(datasetCase)
    } else {
      groups.set(resolved.path, { path: resolved.path, requiresAuthMock: resolved.requiresAuthMock, cases: [datasetCase] })
    }
  }
  return [...groups.values()]
}

async function setAuthMocked(context: BrowserContext, authState: { mocked: boolean }, desired: boolean): Promise<void> {
  if (authState.mocked === desired) return
  if (desired) {
    await context.route('**/api/session/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_AUTH_USER) }),
    )
  } else {
    await context.unroute('**/api/session/me')
  }
  authState.mocked = desired
}

// ---------------------------------------------------------------------------
// UI driving helpers. Every selector below is either role/label-based (the
// app's own accessibility tree, §17.4) or the shadcn `data-slot` convention
// already used throughout `src/components/ui/*` - never a test-only hook and
// never a raw Tailwind class name.
// ---------------------------------------------------------------------------

const NAVIGATION_TIMEOUT_MS = 30_000
const MODEL_READY_POLL_TIMEOUT_MS = 12 * 60 * 1000
const MODEL_READY_POLL_INTERVAL_MS = 2_000
/** §16: the app itself aborts generation at `ASSISTANT_CONFIG.limits.generationTimeoutMs` (60s) - this only needs enough slack past that for the UI to settle. */
const REPLY_SETTLE_TIMEOUT_MS = ASSISTANT_CONFIG.limits.generationTimeoutMs + 20_000
const PROGRESS_LOG_INTERVAL = 25

/**
 * Clicks the first genuinely visible "AIに相談する" launcher. Both
 * `AssistantLauncher` variants ('cta' on the search page, 'icon' in
 * `AppLayout`'s header) share this accessible name (icon via `aria-label`,
 * cta via visible text) - on `DomainSearchPage` several instances
 * (desktop/mobile responsive duplicates of both variants) exist in the DOM
 * at once, only one of which is actually visible at the current viewport.
 */
async function clickVisibleLauncher(page: Page): Promise<void> {
  const candidates = page.getByRole('button', { name: ASSISTANT_LAUNCHER_BUTTON_LABEL })
  const count = await candidates.count()
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    // oxlint-disable-next-line no-await-in-loop -- must check candidates in DOM order, one at a time, until a visible one is found.
    if (await candidate.isVisible()) {
      await candidate.click()
      return
    }
  }
  throw new Error(`No visible "${ASSISTANT_LAUNCHER_BUTTON_LABEL}" launcher button found on ${page.url()}`)
}

type ModelLoadOutcome = 'ready' | 'failed'

/**
 * Polls the ALREADY-OPEN modal for the model reaching READY (§6.2), using
 * only DOM signals `ModelLoading`/`AssistantError` already render - no
 * test-only global is added to the app (per the task brief). `ChatInput` is
 * rendered during both READY and every "still loading" status (§6.4.1: the
 * input stays usable while pending), so "READY" specifically is: the
 * `MODEL_PREPARING_TITLE` heading is gone AND the chat textbox is present.
 * Clicks the `AWAITING_CONSENT` button if it appears (§17.2) - unlikely on
 * a normal broadband dev machine, but harmless if it never shows.
 */
async function waitForModelReady(page: Page): Promise<ModelLoadOutcome> {
  const preparingHeading = page.getByText(MODEL_PREPARING_TITLE, { exact: true })
  const consentButton = page.getByRole('button', { name: CONSENT_TO_DOWNLOAD_BUTTON_LABEL })
  const chatInput = page.getByLabel(CHAT_INPUT_LABEL)
  const errorText = page
    .getByText(MODEL_LOAD_FAILED_MESSAGE, { exact: true })
    .or(page.getByText(MODEL_UNSUPPORTED_MESSAGE, { exact: true }))
    .or(page.getByText(MODEL_STORAGE_INSUFFICIENT_MESSAGE, { exact: true }))

  const deadline = Date.now() + MODEL_READY_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await consentButton.isVisible().catch(() => false)) {
      await consentButton.click().catch(() => {})
    }
    if (await errorText.first().isVisible().catch(() => false)) return 'failed'
    const stillPreparing = await preparingHeading.isVisible().catch(() => false)
    const inputVisible = await chatInput.isVisible().catch(() => false)
    if (!stillPreparing && inputVisible) return 'ready'
    // oxlint-disable-next-line no-await-in-loop -- intentional fixed-interval poll, not a batchable loop.
    await page.waitForTimeout(MODEL_READY_POLL_INTERVAL_MS)
  }
  return 'failed'
}

/**
 * Ensures the next turn starts from a clean slate: the group's page loaded,
 * the assistant modal open, and a brand-new (empty) conversation active -
 * every case gets its own conversation so `historyTurns` (§15.5) never lets
 * one case's turn leak into another's prompt. Also the ONLY place that
 * recovers from a previous case having clicked a Navigation Card (which
 * navigates and closes the modal, §13.1): `page.goBack()` returns to the
 * group's page via the SAME in-page React Router history the app already
 * uses (a real browser back-navigation on a same-document SPA is a
 * client-side transition, not a reload), so the already-loaded WebLLM
 * engine is never torn down and reloaded just to move between cases.
 */
async function prepareCaseTurn(page: Page, groupPath: string): Promise<void> {
  const current = new URL(page.url())
  if (`${current.pathname}${current.search}` !== groupPath) {
    await page.goBack()
    await page.waitForURL((url) => `${url.pathname}${url.search}` === groupPath, { timeout: NAVIGATION_TIMEOUT_MS })
  }

  const dialog = page.getByRole('dialog', { name: ASSISTANT_MODAL_TITLE })
  if (!(await dialog.isVisible().catch(() => false))) {
    await clickVisibleLauncher(page)
    await expect(dialog).toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS })
  }

  await page.getByRole('button', { name: NEW_CONVERSATION_BUTTON_LABEL }).click()
}

/** Every message this run recognizes as a REFUSAL, not a substantive answer - used only for the best-effort `answeredGeneralQuestion` proxy (see README "Honest limitations"). */
const KNOWN_REFUSAL_REPLIES = new Set<string>([
  SUSPICIOUS_INPUT_MESSAGE,
  OUT_OF_SCOPE_MESSAGE,
  DECISION_VALIDATION_FAILED_MESSAGE,
  GENERATION_TIMEOUT_MESSAGE,
  MODEL_LOAD_FAILED_MESSAGE,
])

/**
 * §21.4/`gate.ts`'s `unobservable` tally: the UI never renders
 * `AssistantDecision.intent` anywhere (not in text, not in an attribute) -
 * this recovers it ONLY for the (route, no-route) combinations that are
 * genuinely unambiguous given `playbooks.ts` today (`DOMAIN_LIST` is only
 * ever `VIEW_DOMAIN`'s route; `LOGIN`/`SIGNUP` are only ever
 * `LOGIN_HELP`'s). Every other route (DOMAIN_SEARCH, DOMAIN_DETAIL,
 * DNS_RECORDS, DNS_NAMESERVER) is reachable from several different intents'
 * Playbooks, so guessing among them would be exactly the fabrication the
 * task brief prohibits - those stay `null`.
 */
function inferActualIntent(signal: {
  actualRouteId: RouteId | null
  actualNavigationShown: boolean
  blockedWithoutModel: boolean
}): IntentId | null {
  if (signal.blockedWithoutModel) return 'OUT_OF_SCOPE'
  if (signal.actualNavigationShown && signal.actualRouteId === 'DOMAIN_LIST') return 'VIEW_DOMAIN'
  if (signal.actualNavigationShown && (signal.actualRouteId === 'LOGIN' || signal.actualRouteId === 'SIGNUP')) {
    return 'LOGIN_HELP'
  }
  return null
}

function erroredOutcome(datasetCase: DatasetCase): CaseOutcome {
  return {
    id: datasetCase.id,
    category: datasetCase.category,
    utterance: datasetCase.utterance,
    expectedIntent: datasetCase.expectedIntent,
    expectedRouteId: datasetCase.expectedRouteId,
    expectNavigationCard: datasetCase.expectNavigationCard,
    actualIntent: null,
    actualRouteId: null,
    actualNavigationShown: false,
    actualReply: '',
    blockedWithoutModel: false,
    answeredGeneralQuestion: false,
    navigatedPath: null,
    dnsValueLeaked: false,
    unsafeNavigation: false,
    errored: true,
  }
}

/**
 * Drives one dataset case end-to-end against the ALREADY-OPEN, ALREADY-READY
 * modal (see `prepareCaseTurn`) and records its `CaseOutcome`. Never throws:
 * any failure here (a locator timeout, an unexpected DOM shape, ...) is
 * caught and reported as `errored: true` so one bad case cannot abort the
 * remaining ~499 (task brief requirement).
 */
async function runSingleCase(page: Page, datasetCase: DatasetCase): Promise<CaseOutcome> {
  try {
    const dialog = page.getByRole('dialog', { name: ASSISTANT_MODAL_TITLE })
    const assistantRoleLabels = page.getByText(ASSISTANT_MESSAGE_ROLE_LABEL, { exact: true })
    const priorAssistantCount = await assistantRoleLabels.count()

    await page.getByLabel(CHAT_INPUT_LABEL).fill(datasetCase.utterance)
    await page.getByRole('button', { name: CHAT_INPUT_SEND_BUTTON_LABEL }).click()

    // A new assistant `MessageRow` mounts an `ASSISTANT_MESSAGE_ROLE_LABEL`
    // sr-only span as its first child (`MessageList.tsx`) - this is the same
    // signal a screen reader relies on, not a test-only addition.
    await expect(assistantRoleLabels).toHaveCount(priorAssistantCount + 1, { timeout: REPLY_SETTLE_TIMEOUT_MS })
    const lastRow = assistantRoleLabels.nth(priorAssistantCount).locator('xpath=..')
    // The message reaches a terminal state (done/failed) once its streaming
    // hint is gone - guard-blocked/fixed replies never render this hint at
    // all (status is 'done' from the first paint), so this resolves
    // immediately for them too.
    await expect(lastRow.getByText(MESSAGE_STREAMING_HINT, { exact: true })).toHaveCount(0, {
      timeout: REPLY_SETTLE_TIMEOUT_MS,
    })

    const actualReply = ((await lastRow.locator('p').first().textContent()) ?? '').trim()

    const navigationCard = lastRow.locator('[data-slot="card"]')
    const actualNavigationShown = (await navigationCard.count()) > 0

    let actualRouteId: RouteId | null = null
    let navigatedPath: string | null = null
    let unsafeNavigation = false

    if (actualNavigationShown) {
      const cardTitle = ((await navigationCard.locator('p').first().textContent()) ?? '').trim()
      actualRouteId = ASSISTANT_ROUTES.find((route) => route.title === cardTitle)?.id ?? null

      await navigationCard.getByRole('button').click()
      // `AssistantModal.tsx`'s `handleNavigate` both `navigate()`s and closes
      // the dialog in the same handler - waiting for either is equivalent,
      // `toBeHidden` is the more direct signal that the click was processed.
      await expect(dialog).toBeHidden({ timeout: REPLY_SETTLE_TIMEOUT_MS })

      const landedUrl = new URL(page.url())
      navigatedPath = `${landedUrl.pathname}${landedUrl.search}`
      const landedRouteId = routeIdForPath(landedUrl.pathname, landedUrl.search)
      // Unsafe if the landing path matches no ENABLED Manifest route at all,
      // OR it matches a DIFFERENT route than the card claimed - either way
      // the click did not land where the app told the user it would.
      unsafeNavigation = landedRouteId === null || landedRouteId !== actualRouteId
    }

    const blockedWithoutModel = actualReply === SUSPICIOUS_INPUT_MESSAGE || actualReply === OUT_OF_SCOPE_MESSAGE
    const answeredGeneralQuestion =
      datasetCase.category === 'out_of_scope' && actualReply !== '' && !KNOWN_REFUSAL_REPLIES.has(actualReply)
    // §12.7/FR-16 defence-in-depth re-check: if masking the RENDERED reply
    // changes it, an unmasked DNS-shaped value reached the UI.
    const dnsValueLeaked = maskDnsValueLines(actualReply) !== actualReply

    return {
      id: datasetCase.id,
      category: datasetCase.category,
      utterance: datasetCase.utterance,
      expectedIntent: datasetCase.expectedIntent,
      expectedRouteId: datasetCase.expectedRouteId,
      expectNavigationCard: datasetCase.expectNavigationCard,
      actualIntent: inferActualIntent({ actualRouteId, actualNavigationShown, blockedWithoutModel }),
      actualRouteId,
      actualNavigationShown,
      actualReply,
      blockedWithoutModel,
      answeredGeneralQuestion,
      navigatedPath,
      dnsValueLeaked,
      unsafeNavigation,
      errored: false,
    }
  } catch {
    return erroredOutcome(datasetCase)
  }
}

// ---------------------------------------------------------------------------
// The single, all-500-cases test.
// ---------------------------------------------------------------------------

test('assistant LLM quality evaluation against dataset.json (spec §21.3/§21.4)', async ({ page, context }) => {
  const { dataset, schema } = loadDatasetAndSchema()
  const validation = validateDataset(dataset, schema)
  if (!validation.ok) {
    throw new Error(
      `dataset.json failed validation against dataset.schema.json (${validation.errors.length} error(s)):\n${validation.errors.join('\n')}`,
    )
  }
  const cases = validation.cases

  const authState = { mocked: false }
  const modelLoads = { attempted: 0, succeeded: 0 }
  const outcomesById = new Map<string, CaseOutcome>()
  const groups = groupCasesByPage(cases)

  let completed = 0
  for (const group of groups) {
    // oxlint-disable-next-line no-await-in-loop -- each group must run after the previous one (single shared browser tab/engine, §15.6).
    await setAuthMocked(context, authState, group.requiresAuthMock)
    // oxlint-disable-next-line no-await-in-loop
    await page.goto(group.path)
    // oxlint-disable-next-line no-await-in-loop
    await clickVisibleLauncher(page)
    const dialog = page.getByRole('dialog', { name: ASSISTANT_MODAL_TITLE })
    // oxlint-disable-next-line no-await-in-loop
    await expect(dialog).toBeVisible({ timeout: NAVIGATION_TIMEOUT_MS })

    modelLoads.attempted += 1
    // oxlint-disable-next-line no-await-in-loop
    const loadOutcome = await waitForModelReady(page)
    if (loadOutcome === 'ready') modelLoads.succeeded += 1

    for (const datasetCase of group.cases) {
      let outcome: CaseOutcome
      if (loadOutcome === 'ready') {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: one shared model/engine/conversation flow, §15.6.
        await prepareCaseTurn(page, group.path)
        // oxlint-disable-next-line no-await-in-loop
        outcome = await runSingleCase(page, datasetCase)
      } else {
        outcome = erroredOutcome(datasetCase)
      }

      outcomesById.set(datasetCase.id, outcome)
      completed += 1
      if (completed % PROGRESS_LOG_INTERVAL === 0 || completed === cases.length) {
        console.log(`[assistant-eval] ${completed}/${cases.length} cases done`)
      }
    }
  }

  // Reassemble into the dataset's own eval-001..eval-500 order regardless of
  // the page-grouped execution order above - easier to read/diff between runs.
  const outcomes = cases.map((datasetCase) => outcomesById.get(datasetCase.id)!)

  const metrics = computeMetrics(outcomes, modelLoads)
  const gate = evaluateGate(metrics)
  const unobservable = outcomes.filter((outcome) => outcome.actualIntent === null && !outcome.errored).length

  const report = {
    generatedAt: new Date().toISOString(),
    assistantVersion: ASSISTANT_CONFIG.assistantVersion,
    modelId: ASSISTANT_CONFIG.model.id,
    datasetSize: cases.length,
    metrics,
    gate,
    unobservable,
    outcomes,
  }
  writeFileSync(GATE_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  console.log(`[assistant-eval] wrote ${GATE_REPORT_PATH}`)

  // A gate breach fails the run visibly, with every breached threshold named.
  expect(gate.passed, gate.failures.join('\n')).toBe(true)
})
