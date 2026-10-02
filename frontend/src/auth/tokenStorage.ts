/**
 * Access token persistence.
 *
 * PROVISIONAL (spec §6.8 / TBD #10): the team has not decided between a
 * client-held JWT and a server-side session cookie. FIG.6/FIG.7 are drawn with
 * JWT, so this implementation keeps the token in memory and mirrors it to
 * localStorage for reload survival.
 *
 * If the decision flips to an httpOnly cookie session, only this module and the
 * Authorization header in api/httpClient.ts have to change: nothing else in the
 * app reads the raw token.
 *
 * Known trade-off: a localStorage token is readable by injected scripts (XSS).
 * Acceptable for a hackathon demo, and it never carries registry credentials
 * (spec §3.2.1 / §7.3 forbid those from ever reaching the browser).
 */
const STORAGE_KEY = 'registrar.auth.accessToken'

/** Mirror of the stored token; keeps reads cheap and works in private mode. */
let inMemoryToken: string | null = null
let hydrated = false

function safeReadStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode / disabled storage: fall back to the in-memory copy only.
    return null
  }
}

export function readAccessToken(): string | null {
  if (!hydrated) {
    inMemoryToken = safeReadStorage()
    hydrated = true
  }
  return inMemoryToken
}

export function saveAccessToken(token: string): void {
  inMemoryToken = token
  hydrated = true
  try {
    window.localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // Ignore: the in-memory token still carries the current tab's session.
  }
}

export function clearAccessToken(): void {
  inMemoryToken = null
  hydrated = true
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}
