/**
 * Route guard for protected routes (docs/api-flow-diagrams.html FIG.8).
 *
 *   checking        -> loading only, no redirect decision yet
 *   unauthenticated -> record returnTo, then send the user to /login
 *   authenticated   -> render the route
 */
import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { FullPageLoader } from '../components/FullPageLoader'
import { LOGIN_PATH } from '../config'
import { clearReturnTo, saveReturnTo } from './returnTo'
import { useAuth } from './useAuth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  const location = useLocation()

  useEffect(() => {
    // Arrived: the recorded destination has served its purpose. Dropping it
    // here (not while resolving it) keeps the resolution side-effect free.
    if (state.status === 'authenticated') clearReturnTo()
  }, [state.status])

  if (state.status === 'checking') {
    // Holding the decision here is the whole point of the three-state model:
    // redirecting now would throw out an authenticated user mid-verification.
    return <FullPageLoader message="ログイン状態を確認しています…" />
  }

  if (state.status === 'unauthenticated') {
    const returnTo = `${location.pathname}${location.search}`
    // Written during render on purpose: <Navigate> unmounts this component in
    // the same commit, so an effect would be a race. saveReturnTo is idempotent.
    saveReturnTo(returnTo)
    return <Navigate to={LOGIN_PATH} replace state={{ returnTo }} />
  }

  return <>{children}</>
}
