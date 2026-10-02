/**
 * Per-step guard for the registration wizard.
 *
 * Three rules:
 *   1. An already-authenticated visitor has nothing to register - send them
 *      to the top page. Exception: the moment right after finishing this very
 *      flow (state.completed), because completing logs the new member in and
 *      the 完了 screen must still render.
 *   2. The password lives only in memory (SignupProvider keeps it out of the
 *      sessionStorage draft), while every other prerequisite flag survives a
 *      reload. Without this rule a reload mid-wizard restores started /
 *      emailVerified / contractFilled as true and lets the visitor walk to
 *      確認 with a blank password, which the backend rejects as
 *      `invalid-argument` - so re-ask for it at step 1 instead.
 *   3. A step whose prerequisite is missing (deep link, reload past the
 *      password, skipped verification) redirects back to the furthest step
 *      that is still valid - never to a broken form.
 */
import { Navigate } from 'react-router-dom'
import { PASSWORD_LOST_MESSAGE } from '../../api/signupApi'
import { useAuth } from '../../auth/useAuth'
import { useSignup } from './useSignup'
import type { SignupStepId } from './signupTypes'

export function useSignupGate(step: SignupStepId): React.ReactElement | null {
  const { state: authState } = useAuth()
  const { state } = useSignup()

  // Completing the flow logs the new member in (confirm screen), so while
  // state.completed is set - or on the 完了 screen itself - an authenticated
  // session must NOT be evicted: the auth state can flip while the confirm
  // screen is still mounted, before its navigation to /signup/complete
  // commits. Evicting here would race that navigation and win.
  if (authState.status === 'authenticated' && step !== 'complete' && !state.completed) {
    return <Navigate to="/" replace />
  }

  // The account step needs the in-memory password for the start call, so a
  // reload (which drops the password but keeps the rest of the draft) simply
  // re-asks: step 1 itself has no prerequisite. 完了 is exempt too - by then
  // registration has already succeeded, so a reload there must still render.
  // Carries the reason so step 1 can say why it re-asks - a bare redirect out
  // of 確認 would look like the wizard silently threw the input away.
  if (step !== 'account' && step !== 'complete' && !state.data.password) {
    return <Navigate to="/signup" replace state={{ notice: PASSWORD_LOST_MESSAGE }} />
  }

  if (step === 'verify' && !state.started) return <Navigate to="/signup" replace />
  if (step === 'contract' && !state.emailVerified) {
    return <Navigate to={state.started ? '/signup/verify' : '/signup'} replace />
  }
  if (step === 'confirm' && !state.contractFilled) {
    return <Navigate to={state.emailVerified ? '/signup/contract' : '/signup'} replace />
  }
  if (step === 'complete' && !state.completed) return <Navigate to="/signup" replace />

  return null
}
