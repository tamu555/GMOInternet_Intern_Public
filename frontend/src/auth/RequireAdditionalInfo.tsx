/**
 * Route guard for `/signup/additional-info`. There is nothing to complete if
 * neither the sessionStorage marker nor a live Firebase `currentUser` exists
 * (e.g. a direct/bookmarked navigation with no prior Google sign-in attempt).
 */
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { auth } from '../firebase/client'
import { readAdditionalInfoPending } from './additionalInfoState'

export function RequireAdditionalInfo({ children }: { children: ReactNode }) {
  const hasPendingMarker = readAdditionalInfoPending() !== null
  const hasCurrentUser = auth.currentUser !== null

  if (!hasPendingMarker && !hasCurrentUser) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
