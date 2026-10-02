/**
 * Application-wide configuration.
 *
 * NOTE (spec TBD #10): the backend stack and the authentication scheme are not
 * fixed yet. Every path below is provisional ("仮称" in docs/api-flow-diagrams.html)
 * and mirrors FIG.5-8 of that document.
 */

/** Backend origin. Empty string means "same origin" (Vite dev server / MSW). */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? ''

// The AUTH_ENDPOINTS table (register/login/me) and the domain-search /
// my-page / order endpoint tables were both removed: auth now runs on the
// real Firebase Auth SDK + the Cookie session (src/api/authApi.ts,
// src/api/sessionApi.ts), and domain-search / my-page / orders call Firebase
// callables by name (see src/api/callable.ts and each src/api/*Api.ts
// module).

/**
 * Polling cadence for the order-status polling loop (now the getOrder
 * callable). Read lazily (function, not const) so tests can shrink it via
 * VITE_ORDER_POLL_INTERVAL_MS after module load.
 */
export function orderPollIntervalMs(): number {
  const raw = import.meta.env.VITE_ORDER_POLL_INTERVAL_MS
  const parsed = Number(raw)
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : 1500
}

/**
 * Where an authenticated user lands when no returnTo was recorded (FIG.6).
 * '/' is the public domain-search top page — FIG.6 was updated accordingly
 * ("直前の遷移先 or トップ（ドメイン検索）"). A user bounced off a protected
 * route still returns to that route via returnTo; this default applies only
 * when login/register was opened deliberately.
 */
export const DEFAULT_AUTHENTICATED_PATH = '/'

/** Login screen path used by the route guard and the global 401 handler (FIG.8). */
export const LOGIN_PATH = '/login'

/**
 * Firebase project id. The Docker emulator (docs/firebase/docker-compose.yml)
 * starts with --project=demo-teamc-2026; the demo- prefix guarantees the SDK
 * never reaches a real Firebase project.
 */
export function firebaseProjectId(): string {
  return import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-teamc-2026'
}

/**
 * Whether to connect the Firebase SDK to the Local Emulator Suite. Defaults to
 * true in dev - the emulator is the only backend during the hackathon. Set
 * VITE_FIREBASE_EMULATOR=false only when pointing at a deployed project.
 */
export function firebaseEmulatorEnabled(): boolean {
  const flag = import.meta.env.VITE_FIREBASE_EMULATOR
  if (flag === 'true') return true
  if (flag === 'false') return false
  return import.meta.env.DEV
}

/** Host the emulators listen on (docs/firebase: 0.0.0.0 bind, reachable via 127.0.0.1). */
export function firebaseEmulatorHost(): string {
  return import.meta.env.VITE_FIREBASE_EMULATOR_HOST ?? '127.0.0.1'
}

/** Auth emulator port (firebase.json "emulators.auth.port"). */
export function authEmulatorPort(): number {
  const parsed = Number(import.meta.env.VITE_AUTH_EMULATOR_PORT)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9099
}

/** Functions emulator port (firebase.json "emulators.functions.port"). */
export function functionsEmulatorPort(): number {
  const parsed = Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5001
}

/**
 * GA4 measurement id ("G-XXXXXXXXXX"), issued per web app in the Firebase
 * console. Empty or unset disables Analytics entirely, which is the default
 * for local and CI runs - the id is the only switch, so nothing is collected
 * until a real project is wired up through VITE_FIREBASE_MEASUREMENT_ID.
 */
export function analyticsMeasurementId(): string {
  return import.meta.env.VITE_FIREBASE_MEASUREMENT_ID ?? ''
}

/**
 * The backend does not exist yet, so the mock API (MSW) is the default in dev.
 * Set VITE_ENABLE_MOCKS=false once the real backend is reachable.
 */
export function shouldUseMocks(): boolean {
  const flag = import.meta.env.VITE_ENABLE_MOCKS
  if (flag === 'true') return true
  if (flag === 'false') return false
  return import.meta.env.DEV
}
