import { createContext } from 'react'
import type { ApiError } from '../api/apiError'
import type { LoginInput } from '../api/authApi'
import type { AuthState } from './authTypes'

export type AuthContextValue = {
  /** Three-state machine: checking / authenticated / unauthenticated. */
  state: AuthState
  /**
   * Set when the session check could not be completed for a reason other than
   * "the session is invalid" (network down, backend 5xx). The Cookie is left
   * alone in that case, so a retry can still restore the session.
   */
  restoreError: ApiError | null
  /** FIG.6 - throws ApiError; the form maps it to a message. */
  login: (input: LoginInput) => Promise<void>
  /**
   * Google popup sign-in. `'active'` behaves like `login()`. On
   * `'needs_additional_info'` no Cookie was set - the caller must navigate to
   * the additional-info screen itself; `AuthState` deliberately stays
   * `'unauthenticated'` (see AuthProvider.tsx for why a 4th state was rejected).
   */
  loginWithGoogle: () => Promise<'active' | 'needs_additional_info'>
  logout: () => Promise<void>
  /** Re-run the FIG.7 restore sequence (used after a failed check). */
  recheckSession: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
