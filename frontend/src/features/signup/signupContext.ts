/**
 * Cross-step state for the registration wizard (mirrors auth/authContext.ts).
 *
 * The provider (SignupProvider.tsx) keeps the full RegistrationData in memory
 * and mirrors everything EXCEPT the password to sessionStorage, so input
 * survives both in-app navigation and a reload; the password survives
 * navigation only (deliberate - it is never written to storage).
 */
import { createContext } from 'react'
import type { RegistrationData } from './signupTypes'

export type SignupProgress = {
  /** Step 1 submitted - a pending registration exists server-side. */
  started: boolean
  /** Step 2 passed - the e-mail address is verified. */
  emailVerified: boolean
  /** Step 3 submitted at least once - the confirm screen has data to show. */
  contractFilled: boolean
  /** Registration finished - the complete screen may render. */
  completed: boolean
}

export type SignupState = SignupProgress & {
  data: RegistrationData
}

export type SignupContextValue = {
  state: SignupState
  /** Merge step-1 values and mark the flow as started. */
  saveAccount: (values: Partial<RegistrationData>) => void
  markEmailVerified: () => void
  /** Merge step-3 values and mark the confirm screen as reachable. */
  saveContract: (values: Partial<RegistrationData>) => void
  markCompleted: () => void
  reset: () => void
}

export const SignupContext = createContext<SignupContextValue | null>(null)
