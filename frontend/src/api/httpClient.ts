/**
 * The single HTTP client for our own backend.
 *
 * Same intent as the registry-side common client (spec §4.4): put the shared
 * responsibilities in one place instead of spreading them over call sites.
 *   1. base URL + JSON encoding/decoding
 *   2. Authorization header (JWT, provisional - see auth/tokenStorage.ts)
 *   3. central 401 detection (FIG.8) via the unauthorized bus
 *   4. error normalization into ApiError
 */
import { API_BASE_URL } from '../config'
import { readAccessToken } from '../auth/tokenStorage'
import { ApiError, kindFromStatus } from './apiError'
import { emitUnauthorized } from './unauthorizedBus'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type RequestOptions = {
  method?: HttpMethod
  body?: unknown
  signal?: AbortSignal
  /** Attach the bearer token when one is held. Default: true. */
  withAuth?: boolean
  /**
   * Opt out of the global 401 handler.
   *
   * Two endpoints must opt out, because for them 401 is a normal answer rather
   * than an expired session:
   *   - POST /api/auth/login  : 401 = wrong credentials (FIG.6)
   *   - GET  /api/auth/me     : 401 = the stored token is dead; the restore
   *                             sequence in FIG.7 already handles it
   */
  skipUnauthorizedHandler?: boolean
}

type ErrorBody = {
  message?: string
  code?: string
  fieldErrors?: Record<string, string>
}

async function readJsonSafely(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    signal,
    withAuth = true,
    skipUnauthorizedHandler = false,
  } = options

  const headers = new Headers({ Accept: 'application/json' })
  if (body !== undefined) headers.set('Content-Type', 'application/json')

  const token = withAuth ? readAccessToken() : null
  if (token) headers.set('Authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (cause) {
    // A caller-driven abort is not an error condition; let it propagate as-is.
    if (signal?.aborted) throw cause
    throw new ApiError({ kind: 'network', status: 0, cause })
  }

  const payload = await readJsonSafely(response)

  if (response.ok) {
    return payload as T
  }

  if (response.status === 401 && !skipUnauthorizedHandler) {
    // FIG.8 lower half: token expired / logged out elsewhere. Detected once,
    // here, for every call site.
    emitUnauthorized()
  }

  const errorBody = (payload ?? {}) as ErrorBody
  throw new ApiError({
    kind: kindFromStatus(response.status),
    status: response.status,
    message: errorBody.message,
    code: errorBody.code,
    fieldErrors: errorBody.fieldErrors,
  })
}
