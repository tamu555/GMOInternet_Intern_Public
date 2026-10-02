/**
 * Same-origin `fetch` wrappers for the Cookie-session surface
 * (`functions/src/auth/session.ts`: `issueCsrfToken`, `sessionLogin`,
 * `sessionLogout`, `sessionMe`).
 *
 * These are deliberately NOT routed through `httpClient.ts`/`httpsCallable`:
 * `sessionLogin`/`sessionLogout` are `onRequest` handlers that set/clear an
 * HttpOnly `Set-Cookie` header, which neither the Callable SDK's JSON-only
 * envelope nor `httpClient.ts`'s bearer-token model can express. Every call
 * here carries `credentials: 'include'` so the browser attaches/receives the
 * session cookie.
 *
 * `sessionLogin`'s 200-status outcome (`ok` / `additional_info_required` /
 * `pending_deletion`) is a business discriminator the caller must branch on
 * directly, not an error - see `SessionLoginResult` below. Every non-2xx
 * response (including `permission-denied`, which the backend answers with a
 * real 403) is thrown as a mapped `ApiError` instead.
 */
import { mapSessionFetchError } from '../firebase/errors'
import { ApiError } from './apiError'
import type { AuthUser } from '../auth/authTypes'

const CSRF_HEADER = 'X-CSRF-Token'

/** `application/json` and any `application/<subtype>+json` structured suffix. */
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i

/**
 * Marks a 2xx whose body is not JSON. Non-user-facing (the message stays the
 * generic 'server' wording); it exists so this specific failure is
 * identifiable in a bug report instead of looking like any other 5xx.
 */
const NON_JSON_RESPONSE_CODE = 'non-json-response'

/** `undefined` for an empty or unparseable body. */
function parseJsonSafely(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

async function sessionFetch(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, { ...init, credentials: 'include' })
  } catch (cause) {
    if (init.signal?.aborted) throw cause
    throw new ApiError({ kind: 'network', status: 0, cause })
  }

  const text = await response.text()

  // Error bodies stay best-effort: `mapSessionFetchError` already falls back
  // to a bare 'server' kind when the `{error:{code,message}}` envelope is
  // missing or unreadable.
  if (!response.ok) throw mapSessionFetchError(response.status, parseJsonSafely(text))

  // A 2xx that is not JSON never comes from functions/src/auth/session.ts:
  // every success path there answers `response.status(200).json(...)`. What it
  // DOES come from is an SPA fallback serving index.html where `/api/session/*`
  // should have reached Cloud Functions - the Cloudflare deployment had no
  // equivalent of firebase.json's rewrites until
  // frontend/functions/api/session/[[path]].ts. Swallowing that into
  // `undefined`, as this used to, made the misroute invisible and actively
  // harmful: `sessionMe` handed `undefined` to `AuthProvider` as an AuthUser
  // (a visitor with no cookie became "authenticated", and every RequireAuth
  // route behind it rendered blank), while `issueCsrfToken` destructured
  // `undefined` and turned a completed registration into a generic failure
  // message. Fail loudly so a routing regression cannot masquerade as a
  // session again.
  if (!JSON_MEDIA_TYPE.test(response.headers.get('Content-Type') ?? '')) {
    throw new ApiError({ kind: 'server', status: response.status, code: NON_JSON_RESPONSE_CODE })
  }
  const body = parseJsonSafely(text)
  if (body === undefined) {
    throw new ApiError({ kind: 'server', status: response.status, code: NON_JSON_RESPONSE_CODE })
  }
  return body
}

export type IssueCsrfTokenResponse = { csrfToken: string }

export async function issueCsrfToken(signal?: AbortSignal): Promise<IssueCsrfTokenResponse> {
  return (await sessionFetch('/api/session/csrf', { method: 'GET', signal })) as IssueCsrfTokenResponse
}

export type SessionLoginInput = { idToken: string; csrfToken: string }

export type SessionLoginResult =
  | { status: 'ok' }
  | { status: 'additional_info_required' }
  | { status: 'pending_deletion'; scheduledPurgeAt: string | null; daysRemaining: number }

export async function sessionLogin(input: SessionLoginInput, signal?: AbortSignal): Promise<SessionLoginResult> {
  return (await sessionFetch('/api/session/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: input.csrfToken },
    body: JSON.stringify(input),
    signal,
  })) as SessionLoginResult
}

export async function sessionLogout(signal?: AbortSignal): Promise<void> {
  // Same CSRF double-submit shape as sessionLogin (just no idToken - logout's
  // identity comes from the session cookie itself): mint a fresh token, then
  // send it both as the X-CSRF-Token header and the JSON body's csrfToken.
  const { csrfToken } = await issueCsrfToken(signal)
  await sessionFetch('/api/session/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken },
    body: JSON.stringify({ csrfToken }),
    signal,
  })
}

export async function sessionMe(signal?: AbortSignal): Promise<AuthUser> {
  return (await sessionFetch('/api/session/me', { method: 'GET', signal })) as AuthUser
}
