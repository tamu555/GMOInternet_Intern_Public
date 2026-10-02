/**
 * Mock scenario switches.
 *
 * The backend does not exist yet (TBD #10), so every branch drawn in FIG.5-8
 * has to be reproducible by hand. These switches are what the dev panel toggles
 * and what the MSW handlers read.
 */
export type RegisterScenario = 'ok' | 'partial-contact' | 'conflict' | 'validation-error' | 'server-error'
export type LoginScenario = 'ok' | 'unauthorized' | 'server-error'
export type SessionScenario = 'ok' | 'expired' | 'server-error'
// Search / TLD / order scenarios were retired with the callable migration:
// that surface is faked at the invoke() seam now (src/test/fakeBackend.ts);
// in the browser the real backend (functions/) answers.

export type MockScenario = {
  /** POST /api/auth/register (FIG.5) */
  register: RegisterScenario
  /** POST /api/auth/login (FIG.6) */
  login: LoginScenario
  /** GET /api/auth/me and every protected endpoint (FIG.7 / FIG.8) */
  session: SessionScenario
  /** Artificial latency; raise it to actually see the "確認中" state. */
  latencyMs: number
}

const STORAGE_KEY = 'registrar.mock.scenario'

const DEFAULT_SCENARIO: MockScenario = {
  register: 'ok',
  login: 'ok',
  session: 'ok',
  latencyMs: 400,
}

export const LATENCY_OPTIONS = [0, 400, 2000] as const

let scenario: MockScenario = loadScenario()
const listeners = new Set<() => void>()

function loadScenario(): MockScenario {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SCENARIO
    return { ...DEFAULT_SCENARIO, ...(JSON.parse(raw) as Partial<MockScenario>) }
  } catch {
    return DEFAULT_SCENARIO
  }
}

export function getScenario(): MockScenario {
  return scenario
}

export function setScenario(patch: Partial<MockScenario>): void {
  scenario = { ...scenario, ...patch }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario))
  } catch {
    // Ignore: the in-memory scenario still applies to this tab.
  }
  for (const listener of [...listeners]) listener()
}

export function resetScenario(): void {
  setScenario(DEFAULT_SCENARIO)
}

export function subscribeScenario(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
