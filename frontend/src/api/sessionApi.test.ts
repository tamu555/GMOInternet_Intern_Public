/**
 * Regression guard for the production incident where `/api/session/*` was not
 * routed to Cloud Functions at all.
 *
 * The Cloudflare deployment had no equivalent of firebase.json's
 * `/api/session/*` rewrites, so those paths fell through to the SPA fallback
 * and answered `index.html` with HTTP 200. `sessionFetch` used to parse that
 * best-effort, get `undefined`, see `response.ok`, and return it as the
 * successful result - which made a visitor with no cookie "authenticated" and
 * turned a completed registration into "登録を完了できませんでした".
 *
 * The routing itself is restored by frontend/functions/api/session/[[path]].ts.
 * These tests pin the client-side half: a 2xx that is not JSON must be an
 * error, never an empty success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './apiError'
import { issueCsrfToken, sessionLogin, sessionMe } from './sessionApi'

const SPA_FALLBACK_HTML = '<!doctype html><html><head><title>zerokaradomain</title></head><body></body></html>'

/**
 * A fresh Response per call: a Response body can only be read once, and
 * `sessionFetch` always reads it, so handing the same instance to two calls
 * would fail on the second with an unrelated "Body has already been read".
 */
function mockFetch(build: () => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => build())
}

function htmlResponse(status = 200): Response {
  return new Response(SPA_FALLBACK_HTML, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sessionFetch: a 2xx that is not JSON', () => {
  it('rejects the SPA fallback instead of reporting an authenticated user', async () => {
    mockFetch(() => htmlResponse())

    // The incident's exact shape: `sessionMe` resolving to `undefined` is what
    // AuthProvider stored as the AuthUser.
    await expect(sessionMe()).rejects.toBeInstanceOf(ApiError)
    await expect(sessionMe()).rejects.toMatchObject({ kind: 'server', code: 'non-json-response' })
  })

  it('rejects on the CSRF bootstrap, which used to throw a bare TypeError downstream', async () => {
    mockFetch(() => htmlResponse())

    // `completeSignup` does `const { csrfToken } = await issueCsrfToken()`, so
    // an `undefined` here surfaced as a TypeError - an error the signup screen
    // could only report with its generic fallback sentence.
    await expect(issueCsrfToken()).rejects.toMatchObject({ kind: 'server', code: 'non-json-response' })
  })

  it('rejects an empty 2xx body', async () => {
    mockFetch(() => new Response('', { status: 200 }))

    await expect(sessionMe()).rejects.toMatchObject({ kind: 'server', code: 'non-json-response' })
  })

  it('rejects a JSON content-type whose body does not parse', async () => {
    mockFetch(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(sessionMe()).rejects.toMatchObject({ kind: 'server', code: 'non-json-response' })
  })
})

describe('sessionFetch: unchanged behaviour', () => {
  it('returns the parsed body of a JSON 2xx', async () => {
    mockFetch(() => jsonResponse({ id: '1', email: 'demo@example.com', displayName: 'Taro Test' }))

    await expect(sessionMe()).resolves.toEqual({ id: '1', email: 'demo@example.com', displayName: 'Taro Test' })
  })

  it('passes a sessionLogin business outcome through as a value, not an error', async () => {
    mockFetch(() => jsonResponse({ status: 'additional_info_required' }))

    await expect(sessionLogin({ idToken: 'id-token', csrfToken: 'csrf-token' })).resolves.toEqual({
      status: 'additional_info_required',
    })
  })

  it('still maps a JSON error envelope by its code, not by the new guard', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'unauthenticated', message: 'Authentication failed.' } }, 401))

    await expect(sessionMe()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })
  })

  it('still maps a non-JSON error response by its status', async () => {
    // Error bodies stay best-effort on purpose: an infrastructure 502 that
    // answers HTML must keep mapping to 'server', not to the new guard.
    mockFetch(() => htmlResponse(502))

    await expect(sessionMe()).rejects.toMatchObject({ kind: 'server', status: 502 })
  })

  it('maps a network failure to kind network', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(sessionMe()).rejects.toMatchObject({ kind: 'network', status: 0 })
  })
})
