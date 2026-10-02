/**
 * Shared test helper: mocks the Cookie-session surface (`/api/session/csrf`,
 * `/api/session/login`, `/api/session/logout`, `/api/session/me` -
 * `api/sessionApi.ts`) that `AuthProvider.tsx` now unconditionally checks on
 * every mount (architecture doc §1.4(d), Cookie-first). Every other URL falls
 * through to the real (possibly MSW-patched) `fetch`, so callers that also
 * need MSW for `domainsApi`/`ordersApi`/`mypageApi` keep working unmodified -
 * this is the one consistent pattern used by every integration test file that
 * renders `<AppRouter />` (authFlows/signupFlow/GoogleAdditionalInfoPage/
 * domainSearchFlow/mypageFlow/orderFlow).
 *
 * Bridges a second, real compatibility gap on the way through: once a
 * Cookie-authenticated mount succeeds, `AuthProvider.runSessionCheck` writes
 * `SESSION_TOKEN_SENTINEL` ('firebase-session') to `tokenStorage.ts` (the
 * §1.4(c) shim, now correctly covering the mount-restore path too - see this
 * module's own bug report). But `mocks/db.ts`'s `resolveToken()` - the mock
 * backend `domainsApi`/`ordersApi`/`mypageApi` calls still go through - only
 * recognizes its own `mock.<payload>.unsigned` JWT shape, never the sentinel.
 * Left alone, every authenticated-but-still-MSW-backed call would 401 the
 * instant `AuthProvider` (correctly) overwrites whatever token a test wrote
 * by hand. This helper closes that gap transparently: any outgoing request
 * whose `Authorization` header is exactly the sentinel gets it swapped for a
 * real mock JWT (`issueToken`) for the matching seeded `mocks/db.ts` user,
 * right before handing off to the real fetch/MSW - callers only ever need to
 * call `authenticate()`, no separate `saveAccessToken(issueToken(...))` step.
 */
import { vi } from 'vitest'
import { SESSION_TOKEN_SENTINEL } from '../api/authApi'
import type { AuthUser } from '../auth/authTypes'
import { findUserByEmail, issueToken } from './db'

export const DEFAULT_SESSION_USER: AuthUser = {
  id: '1',
  email: 'demo@example.com',
  displayName: 'Taro Test',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export type SessionFetchMock = {
  /** Marks a valid Cookie session as already established (e.g. before render, to simulate "already logged in"). */
  authenticate: (user?: AuthUser) => void
  /** Clears the Cookie session, as `sessionLogout()` (or another tab logging out) would. */
  clear: () => void
}

/**
 * Call once per test (typically in `beforeEach`, after any per-test fetch
 * mock from a previous test has been restored). Returns a controller for
 * flipping the modeled session state mid-test.
 */
export function installSessionFetchMock(): SessionFetchMock {
  const originalFetch = globalThis.fetch
  let authenticatedUser: AuthUser | null = null

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/session/csrf')) return jsonResponse({ csrfToken: 'csrf-token' })
    if (url.includes('/api/session/login')) {
      authenticatedUser ??= DEFAULT_SESSION_USER
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/logout')) {
      authenticatedUser = null
      return jsonResponse({ status: 'ok' })
    }
    if (url.includes('/api/session/me')) {
      if (!authenticatedUser) {
        return jsonResponse({ error: { code: 'unauthenticated', message: 'no session' } }, 401)
      }
      return jsonResponse(authenticatedUser)
    }

    // Passthrough to the real backend surface (still MSW-backed): swap the
    // sentinel for a real mock JWT if one applies (see the module doc above).
    const headers = new Headers(init?.headers)
    if (authenticatedUser && headers.get('Authorization') === `Bearer ${SESSION_TOKEN_SENTINEL}`) {
      const mockUser = findUserByEmail(authenticatedUser.email)
      if (mockUser) {
        headers.set('Authorization', `Bearer ${issueToken(mockUser)}`)
        return originalFetch(input, { ...init, headers })
      }
    }
    return originalFetch(input, init)
  })

  return {
    authenticate: (user = DEFAULT_SESSION_USER) => {
      authenticatedUser = user
    },
    clear: () => {
      authenticatedUser = null
    },
  }
}
