/**
 * Inverse guard for /login and /register.
 *
 * Same three-state rule as RequireAuth: while the session is being verified we
 * render the loader instead of the form, so a reload on /login does not flash a
 * login form at someone who is already signed in (FIG.7).
 *
 * This is also the single place that resolves the post-login destination
 * (FIG.6 "直前の遷移先 or ダッシュボードへリダイレクト"). Keeping it here - and
 * not in the login form - means one component decides where the user lands.
 */
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { FullPageLoader } from '../components/FullPageLoader'
import { resolveReturnTo } from './returnTo'
import { useAuth } from './useAuth'

type LocationState = { returnTo?: string } | null

export function RequireGuest({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  const location = useLocation()

  if (state.status === 'checking') {
    return <FullPageLoader message="ログイン状態を確認しています…" />
  }

  if (state.status === 'authenticated') {
    const routerState = location.state as LocationState
    return <Navigate to={resolveReturnTo(routerState?.returnTo)} replace />
  }

  return <>{children}</>
}
