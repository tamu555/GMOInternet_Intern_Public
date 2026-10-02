/**
 * Client-side re-authentication for account deletion (docs/仕様/auth.md §4.8).
 *
 * `deleteAccountWithPassword` / `deleteAccountWithGoogle` (functions/src/auth/
 * account-lifecycle.ts) both require a *fresh* ID token
 * (`auth_time` within `AUTH_TIME_FRESHNESS_SECONDS`, currently 5 minutes) and
 * refuse a stale one with `failed-precondition`. The backend can only check
 * that freshness - it cannot verify a password or replay a Google login
 * itself - so "confirm it's really you" happens here, client-side, via the
 * Firebase Auth SDK, immediately before the deletion Callable is invoked.
 *
 * Both functions throw a plain `ApiError` (via `mapAuthError`) on any
 * failure, matching every other Firebase Auth call site in this app
 * (AuthProvider.tsx's `loginWithGoogle`).
 */
import { EmailAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup } from 'firebase/auth'
import { ApiError } from '../api/apiError'
import { auth } from '../firebase/client'
import { mapAuthError } from '../firebase/errors'
import { googleProvider } from './googleAuthProvider'

/** No `auth.currentUser` means the session died between page load and this call - not a reauth failure per se, but nothing to reauthenticate either. */
function requireCurrentUser() {
  const user = auth.currentUser
  if (!user) throw new ApiError({ kind: 'unauthorized', status: 401 })
  return user
}

/** §4.8.1: メールアドレス＋パスワードでの再認証 (`reauthenticateWithCredential`). */
export async function reauthenticateWithPassword(password: string): Promise<void> {
  const user = requireCurrentUser()
  if (!user.email) throw new ApiError({ kind: 'unauthorized', status: 401 })
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
  } catch (error) {
    throw mapAuthError(error)
  }
}

/** §4.8.2: Google再ログインでの再認証。AuthProvider.tsx と同じ GoogleAuthProvider インスタンスを使う。 */
export async function reauthenticateWithGoogle(): Promise<void> {
  const user = requireCurrentUser()
  try {
    await reauthenticateWithPopup(user, googleProvider)
  } catch (error) {
    throw mapAuthError(error)
  }
}
