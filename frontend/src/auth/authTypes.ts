/**
 * Authentication state model (docs/api-flow-diagrams.html FIG.7 / FIG.8).
 *
 * The status is deliberately a three-value union, never a boolean:
 * "checking" (session restore in flight) must stay distinguishable from
 * "unauthenticated", otherwise an authenticated user sees the login screen
 * flicker on every reload.
 */
export type AuthUser = {
  id: string
  email: string
  displayName: string
}

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated'

export type AuthState =
  | { status: 'checking'; user: null }
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'unauthenticated'; user: null }

export const CHECKING_STATE: AuthState = { status: 'checking', user: null }
export const UNAUTHENTICATED_STATE: AuthState = { status: 'unauthenticated', user: null }

export function authenticatedState(user: AuthUser): AuthState {
  return { status: 'authenticated', user }
}
