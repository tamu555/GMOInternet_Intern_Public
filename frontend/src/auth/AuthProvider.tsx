/**
 * Session state owner (docs/api-flow-diagrams.html FIG.7 / FIG.8).
 *
 * Cookie-first authority: the HttpOnly session cookie set by
 * `sessionApi.sessionLogin` is the sole source of truth, not local storage.
 * Mount sequence:
 *   1. state = "checking"  (never "unauthenticated" first - that is the flicker bug)
 *   2. GET /api/session/me (credentials included)
 *        200 -> "authenticated"
 *        401 -> "unauthenticated" (no cookie, or an expired/revoked one)
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { signInWithPopup } from 'firebase/auth'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/apiError'
import { fetchMe, login as loginRequest, SESSION_TOKEN_SENTINEL } from '../api/authApi'
import type { LoginInput } from '../api/authApi'
import * as sessionApi from '../api/sessionApi'
import { onUnauthorized } from '../api/unauthorizedBus'
import { LOGIN_PATH } from '../config'
import { auth } from '../firebase/client'
import { mapAuthError } from '../firebase/errors'
import { clearAssistantChat } from '../features/assistant/store/chatStore'
import { clearSignupDraft } from '../features/signup/signupDraftStorage'
import { clearAdditionalInfoPending, saveAdditionalInfoPending } from './additionalInfoState'
import { AuthContext, type AuthContextValue } from './authContext'
import { authenticatedState, CHECKING_STATE, UNAUTHENTICATED_STATE, type AuthState, type AuthUser } from './authTypes'
import { googleProvider } from './googleAuthProvider'
import { clearReturnTo } from './returnTo'
import { clearAccessToken, saveAccessToken } from './tokenStorage'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(CHECKING_STATE)
  const [restoreError, setRestoreError] = useState<ApiError | null>(null)
  // AppRouter.tsx mounts AuthProvider inside BrowserRouter, so useNavigate is
  // always available here - see logout()'s issue #84 comment below.
  const navigate = useNavigate()

  /**
   * Guards against a late GET /api/session/me overwriting a newer state (the
   * user may log in, log out, or trigger a re-check while the first check is
   * still in flight). Every state-changing entry point bumps the generation.
   */
  const generationRef = useRef(0)
  /**
   * Whether this tab has ever reached `authenticated`. Read by
   * `clearAssistantChatOnDeauth` so the assistant conversation is dropped only
   * on a real authenticated -> unauthenticated transition.
   */
  const wasAuthenticatedRef = useRef(false)

  /**
   * §7.3: clear the assistant conversation on every path that leaves the
   * `authenticated` state, so a second user inheriting this tab never sees the
   * first user's chat. Guarded on `wasAuthenticatedRef` because the same three
   * call sites also fire for visitors who were never signed in (the mount-time
   * `runSessionCheck` 401 is the common case), and §7.3 requires an
   * unauthenticated visitor's conversation to survive until the tab closes.
   */
  const clearAssistantChatOnDeauth = useCallback((): void => {
    if (!wasAuthenticatedRef.current) return
    wasAuthenticatedRef.current = false
    clearAssistantChat()
  }, [])

  const runSessionCheck = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current
    const isCurrent = () => generation === generationRef.current

    setState(CHECKING_STATE)
    setRestoreError(null)

    try {
      const user = await fetchMe()
      if (!isCurrent()) return
      // The mount-time restore path (a live Cookie, but this tab/session
      // never ran login()/loginWithGoogle()/completeSignup() itself - e.g. a
      // reload, or the very first check after signupApi.completeSignup()
      // established the Cookie directly) must still write the sentinel here,
      // not only in applyAuthSuccess: otherwise the Cookie-authenticated UI
      // would silently drop the Authorization header on every subsequent
      // domains/orders/mypage call, defeating the §1.4(c) shim entirely for
      // this specific path.
      saveAccessToken(SESSION_TOKEN_SENTINEL)
      wasAuthenticatedRef.current = true
      setState(authenticatedState(user))
    } catch (error) {
      if (!isCurrent()) return
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        // No valid cookie: the sentinel (if any) is worthless too.
        clearAccessToken()
      } else {
        // Divergence from FIG.7, on purpose: a network failure or a backend 5xx
        // does not prove the session is dead, so we surface a retry instead of
        // silently logging a valid user out.
        setRestoreError(error instanceof ApiError ? error : new ApiError({ kind: 'unknown', status: 0 }))
      }
      // §7.3: authenticated -> unauthenticated transition - clear any
      // conversation so a second user inheriting this tab never sees it.
      clearAssistantChatOnDeauth()
      setState(UNAUTHENTICATED_STATE)
    }
  }, [clearAssistantChatOnDeauth])

  useEffect(() => {
    // Synchronizing React with two external systems (the Cookie + backend),
    // which is exactly what an effect is for. The "checking" state is set
    // synchronously above: FIG.7 requires the first state to be "確認中", so
    // it cannot be derived during render without losing that guarantee.
    // oxlint-disable-next-line react/set-state-in-effect
    void runSessionCheck()
  }, [runSessionCheck])

  useEffect(
    () =>
      // FIG.8 lower half: any 401 from the common HTTP client resets the state.
      // The route guard then does the redirect, so the returnTo path is recorded
      // from wherever the user actually was.
      onUnauthorized(() => {
        generationRef.current += 1
        clearAccessToken()
        setRestoreError(null)
        // §7.3: authenticated -> unauthenticated transition (401 from any
        // HTTP client call) - clear any conversation, same reason as above.
        clearAssistantChatOnDeauth()
        setState(UNAUTHENTICATED_STATE)
      }),
    [clearAssistantChatOnDeauth],
  )

  const applyAuthSuccess = useCallback((accessToken: string, user: AuthUser) => {
    generationRef.current += 1
    // Fixed, non-secret sentinel - see authApi.ts's SESSION_TOKEN_SENTINEL
    // doc comment. Kept so httpClient.ts's Authorization header behavior for
    // the out-of-scope domains/orders/mypage modules never changes.
    saveAccessToken(accessToken)
    setRestoreError(null)
    wasAuthenticatedRef.current = true
    setState(authenticatedState(user))
  }, [])

  const login = useCallback(
    async (input: LoginInput): Promise<void> => {
      const result = await loginRequest(input)
      applyAuthSuccess(result.accessToken, result.user)
    },
    [applyAuthSuccess],
  )

  const loginWithGoogle = useCallback(async (): Promise<'active' | 'needs_additional_info'> => {
    let idToken: string
    let uid: string
    let email: string | null
    try {
      const credential = await signInWithPopup(auth, googleProvider)
      idToken = await credential.user.getIdToken()
      uid = credential.user.uid
      email = credential.user.email
    } catch (error) {
      throw mapAuthError(error)
    }

    const { csrfToken } = await sessionApi.issueCsrfToken()
    const result = await sessionApi.sessionLogin({ idToken, csrfToken })

    if (result.status === 'additional_info_required') {
      // No cookie was set (resolveLoginState cleared it). Deliberately does
      // NOT touch AuthState - it stays 'unauthenticated', there is nothing to
      // restore yet. The caller navigates to the additional-info screen.
      saveAdditionalInfoPending({ uid, email: email ?? '' })
      return 'needs_additional_info'
    }
    if (result.status !== 'ok') {
      throw new ApiError({ kind: 'forbidden', status: 0, message: 'ログインできませんでした。' })
    }

    clearAdditionalInfoPending()
    const user = await fetchMe()
    applyAuthSuccess(SESSION_TOKEN_SENTINEL, user)
    return 'active'
  }, [applyAuthSuccess])

  const logout = useCallback(async (): Promise<void> => {
    generationRef.current += 1
    clearAccessToken()
    setRestoreError(null)
    // §7.3: authenticated -> unauthenticated transition - clear any
    // conversation, same reason as above.
    clearAssistantChatOnDeauth()
    // Explicit "I'm done" signal (issue #85): drop the signup wizard's PII
    // mirror unconditionally - unlike the assistant chat this is never
    // gated on wasAuthenticatedRef, and it must NOT be wired into the
    // mount-time 401 check or onUnauthorized above, since an anonymous
    // visitor mid-wizard needs the draft to survive a reload. Removing an
    // already-absent key is a harmless no-op.
    clearSignupDraft()
    // issue #84: an intentional logout must never record a returnTo. If we
    // just flip to UNAUTHENTICATED_STATE while still mounted on a protected
    // route, RequireAuth's unauthenticated branch re-captures *this* URL
    // (both to sessionStorage and to the /login navigation's router state)
    // before RequireGuest ever runs - so whichever account logs in next (not
    // necessarily this one) gets auto-navigated back to a page it may not
    // own, producing a real-but-wrong-owner 403 from the backend's ownership
    // check. Navigating to /login ourselves, with no state, and clearing any
    // already-stored returnTo, BEFORE flipping the auth state, means
    // RequireAuth never re-arms it for this logout. The session-expiry
    // (onUnauthorized) 401 path deliberately does NOT do this: there the
    // user should still be sent back to where they were after re-login.
    clearReturnTo()
    navigate(LOGIN_PATH, { replace: true })
    // React Router's <BrowserRouter> (see AppRouter.tsx) applies its own
    // location-state update inside React.startTransition by default, which is
    // *lower* priority than a plain setState. Left unguarded, this setState
    // would commit first, in a render that still has the *old* location -
    // RequireAuth would see unauthenticated at the old protected path and
    // re-arm returnTo right back, defeating the fix above. Wrapping this
    // setState in startTransition too puts both updates in the same
    // transition lane so they land in the same commit, with the new location
    // already in place.
    startTransition(() => {
      setState(UNAUTHENTICATED_STATE)
    })
    // Best-effort: the client already looks logged out regardless of whether
    // the server-side cookie revoke or the local Firebase sign-out succeeds.
    try {
      await sessionApi.sessionLogout()
    } catch {
      // Ignore.
    }
    try {
      await auth.signOut()
    } catch {
      // Ignore.
    }
  }, [clearAssistantChatOnDeauth, navigate])

  const value = useMemo<AuthContextValue>(
    () => ({ state, restoreError, login, loginWithGoogle, logout, recheckSession: runSessionCheck }),
    [state, restoreError, login, loginWithGoogle, logout, runSessionCheck],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
