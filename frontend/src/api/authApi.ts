/**
 * Auth API façade (docs/api-flow-diagrams.html FIG.5-7).
 *
 * The external shape (`LoginInput`, `AuthSuccessResponse`, `login`,
 * `fetchMe`) is preserved so `AuthProvider.tsx` and the out-of-scope
 * `domains`/`orders`/`mypage` API modules never need to change - only the
 * internals now drive the real Firebase Auth SDK + the Cookie session
 * (`sessionApi.ts`) instead of the old mocked REST endpoints.
 *
 * `register`/`RegisterInput` are intentionally REMOVED, not preserved: their
 * sole caller (`RegisterPage.tsx`) is retired by this same feature, and a
 * partial-profile registration path would contradict the "full profile via
 * /signup only" success criterion.
 */
import { signInWithEmailAndPassword } from 'firebase/auth'
import type { AuthUser } from '../auth/authTypes'
import { auth } from '../firebase/client'
import { mapAuthError } from '../firebase/errors'
import { ApiError } from './apiError'
import * as sessionApi from './sessionApi'

export type LoginInput = {
  email: string
  password: string
}

export type AuthSuccessResponse = {
  accessToken: string
  user: AuthUser
  /**
   * FIG.5: the backend creates one contact per registry (§5.1) in parallel and
   * reports "both_ready" or "partial". The UI deliberately ignores this field -
   * registration succeeded either way, and the failed side is retried on the
   * first order for that registry (§6.8). It is typed here only so the shape of
   * the response stays documented.
   */
  contactStatus?: 'both_ready' | 'partial'
}

/**
 * Fixed, non-secret placeholder written where the old flow held a real JWT.
 * NEVER the actual Firebase ID token: the Cookie session (HttpOnly, set by
 * `sessionApi.sessionLogin`) is the sole source of truth for this app's own
 * auth logic. This sentinel exists only so `httpClient.ts`'s existing
 * `Authorization: Bearer <token>` header keeps firing byte-for-byte
 * unchanged for the out-of-scope `domainsApi`/`ordersApi`/`mypageApi`
 * modules, which still read `tokenStorage.ts` directly.
 */
export const SESSION_TOKEN_SENTINEL = 'firebase-session'

/** A non-'ok' `sessionLogin` outcome reachable from the password flow. */
function loginOutcomeError(result: Exclude<sessionApi.SessionLoginResult, { status: 'ok' }>): ApiError {
  if (result.status === 'pending_deletion') {
    return new ApiError({ kind: 'forbidden', status: 0, message: 'このアカウントは削除手続き中のため、ログインできません。' })
  }
  return new ApiError({ kind: 'forbidden', status: 0, message: 'ログインできませんでした。' })
}

/** FIG.6: sign in with Firebase Auth, then exchange the ID token for a session cookie. */
export async function login(input: LoginInput): Promise<AuthSuccessResponse> {
  let idToken: string
  try {
    const credential = await signInWithEmailAndPassword(auth, input.email, input.password)
    idToken = await credential.user.getIdToken()
  } catch (error) {
    // auth/wrong-password et al. map to 'unauthorized' - "401 is a form
    // error, not a dead session" continues to hold under Firebase.
    throw mapAuthError(error)
  }

  const { csrfToken } = await sessionApi.issueCsrfToken()
  const result = await sessionApi.sessionLogin({ idToken, csrfToken })
  if (result.status !== 'ok') throw loginOutcomeError(result)

  const user = await fetchMe()
  return { accessToken: SESSION_TOKEN_SENTINEL, user }
}

/** FIG.7: the Cookie is the authority - a missing/expired one 401s here. */
export async function fetchMe(signal?: AbortSignal): Promise<AuthUser> {
  return sessionApi.sessionMe(signal)
}
