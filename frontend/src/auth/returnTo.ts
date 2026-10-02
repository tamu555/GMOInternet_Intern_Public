/**
 * "Where the user was heading before we bounced them to /login" (FIG.8).
 *
 * The path travels two ways on purpose:
 *   1. router location state - the normal, in-memory hand-off;
 *   2. sessionStorage - survives a reload of the login screen itself.
 */
import { DEFAULT_AUTHENTICATED_PATH, LOGIN_PATH } from '../config'

const STORAGE_KEY = 'registrar.auth.returnTo'

/** Paths that must never be a return target (they would bounce the user back). */
const EXCLUDED_PREFIXES = [LOGIN_PATH, '/register']

/**
 * Only same-origin absolute paths are accepted. This blocks the classic
 * open-redirect ("//evil.example" is a protocol-relative URL, not a path).
 */
export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (!path) return false
  if (!path.startsWith('/') || path.startsWith('//')) return false
  return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`))
}

export function saveReturnTo(path: string): void {
  if (!isSafeReturnPath(path)) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, path)
  } catch {
    // Ignore: the router location state still carries the path in this tab.
  }
}

function readStoredReturnTo(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function clearReturnTo(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}

/**
 * Resolve the post-login destination: router state first, stored path second,
 * the search top page last (FIG.6 "直前の遷移先 or トップ（ドメイン検索）").
 *
 * Pure on purpose - the route guard calls it while rendering, and React may
 * render the same component more than once for one commit. The stored path is
 * dropped by clearReturnTo() once the user actually reaches a protected route,
 * so it is never consumed by a render that gets thrown away.
 */
export function resolveReturnTo(candidateFromRouter?: string | null): string {
  if (isSafeReturnPath(candidateFromRouter)) return candidateFromRouter
  const stored = readStoredReturnTo()
  if (isSafeReturnPath(stored)) return stored
  return DEFAULT_AUTHENTICATED_PATH
}
