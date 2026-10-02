/**
 * Mock backend for what still rides MSW after the callable migration.
 *
 * The auth/session/signup surface no longer goes through MSW at all: real
 * Firebase Auth + Callable Functions + the Cookie session (see
 * `api/authApi.ts`, `api/signupApi.ts`, `api/sessionApi.ts`) replaced the old
 * `/api/auth/register|login|me` and `/api/signup/*` REST mocks. `sessionMockHandlers`
 * below is NOT that old surface - it is a Node-test-only fallback for the
 * Cookie-session endpoints (`/api/session/*`) so `AuthProvider`'s
 * unconditional session check has something to answer in tests; see its own
 * doc comment for why the real browser dev worker excludes it.
 *
 * Domain search / orders / my-page also moved to Firebase callables (all
 * real, functions/) and their REST handlers were removed; tests fake
 * that surface at the invoke() seam instead (src/test/fakeBackend.ts). MSW
 * keeps ONLY the read-only seed list behind GET /api/domains for the FIG.8
 * dashboard demo (pages/DashboardPage.tsx) and the dev token revoker.
 */
import { HttpResponse, delay, http } from 'msw'
import { bearerTokenFrom, listDomains, resolveToken, revokeToken, type MockDomain, type MockUser } from './db'
import { getScenario } from './scenario'

/** Kept for the FIG.8 dashboard demo's GET /api/domains. */
function serializeDomainSummary(domain: MockDomain) {
  return {
    name: domain.name,
    registry: domain.registry,
    statuses: domain.statuses,
    rgpStatuses: domain.rgpStatuses,
    exDate: domain.exDate,
    autoRenew: domain.autoRenew,
    restorableUntil: domain.restorableUntil,
    autoRenewCancelableUntil: domain.autoRenewCancelableUntil,
    // Back-compat: the dashboard demo reads a single status.
    status: domain.statuses[0] ?? 'ok',
  }
}

function serverError() {
  return HttpResponse.json({ message: 'internal server error' }, { status: 500 })
}

function unauthorized(message: string) {
  return HttpResponse.json({ message }, { status: 401 })
}

/** Shared session check for every protected endpoint. */
function authenticate(request: Request): { user: MockUser } | { response: Response } {
  const scenario = getScenario()
  if (scenario.session === 'server-error') return { response: serverError() }

  const token = bearerTokenFrom(request)
  if (scenario.session === 'expired') {
    return { response: unauthorized('token expired') }
  }

  const user = resolveToken(token)
  if (!user) return { response: unauthorized('invalid token') }
  return { user }
}

// Cookie-session surface (functions/src/auth/session.ts) default fallbacks.
// Used ONLY by the Node test server (server.ts), never by the real browser
// dev worker (browser.ts): in local dev a real backend is actually running
// (Vite's /api/session/* proxy -> the Functions emulator), and registering
// these here would silently swallow every real session call before it ever
// reaches that backend - the opposite of what local dev needs. Tests, on the
// other hand, have no real backend at all, so every test that mounts
// AuthProvider (which calls GET /api/session/me unconditionally on every
// mount) needs a default here or MSW's onUnhandledRequest:'error' would
// hard-crash every test that never touches auth itself.
//
// This mock never sees a real Cookie (nothing in this file sets one), so it
// always answers "no session" - the same default the real backend gives an
// anonymous visitor. Tests that need an authenticated AuthState must drive
// the real login()/loginWithGoogle() flow (mocking firebase/auth + fetch,
// see GoogleAdditionalInfoPage.test.tsx for the pattern) - writing straight
// to tokenStorage.ts no longer produces one, by design (Cookie is the sole
// authority now). Overridable per test via `server.use(...)`, same as every
// other handler in this file.
export const sessionMockHandlers = [
  // Deliberately NO artificial delay() here, unlike every other handler in
  // this file: every other endpoint only fires when a specific user action
  // is under test, but this one fires on literally every app mount in every
  // test (the FIG.7 restore sequence), so the usual scenario.latencyMs would
  // tax every single test in this suite - including ones that assert on
  // unauthenticated/public content and were never timed against that cost.
  http.get('/api/session/me', async () => {
    return HttpResponse.json({ error: { code: 'unauthenticated', message: 'Authentication failed.' } }, { status: 401 })
  }),
  // issueCsrfToken never depends on session state in the real backend either
  // (it is the bootstrap call before a session exists) - always succeeds.
  http.get('/api/session/csrf', async () => {
    return HttpResponse.json({ csrfToken: 'msw-mock-csrf-token' }, { status: 200 })
  }),
  // "Not logged in" is the correct default baseline for both of these -
  // a test that wants a successful login/logout overrides the specific
  // handler for that one test via server.use(...).
  http.post('/api/session/login', async () => {
    return HttpResponse.json({ error: { code: 'unauthenticated', message: 'Authentication failed.' } }, { status: 401 })
  }),
  http.post('/api/session/logout', async () => {
    return HttpResponse.json({ error: { code: 'unauthenticated', message: 'Authentication failed.' } }, { status: 401 })
  }),
]

export const handlers = [
  ...sessionMockHandlers,

  // The sample protected resource the FIG.8 dashboard demo calls (the my-page
  // list itself moved to the real listDomains callable).
  http.get('/api/domains', async ({ request }) => {
    await delay(getScenario().latencyMs)
    const result = authenticate(request)
    if ('response' in result) return result.response
    return HttpResponse.json({ domains: listDomains().map(serializeDomainSummary) }, { status: 200 })
  }),

  /**
   * Dev-only: invalidates the caller's token so the next API call returns 401.
   * Stands in for "token expired" / "logged out on another device" (FIG.8).
   */
  http.post('/api/dev/revoke-token', async ({ request }) => {
    await delay(getScenario().latencyMs)
    const token = bearerTokenFrom(request)
    if (token) revokeToken(token)
    return new HttpResponse(null, { status: 204 })
  }),
]
