/**
 * State holder for the registration wizard. See signupContext.ts for the
 * model; this file only implements it (same split as auth/AuthProvider.tsx).
 * The sessionStorage draft mechanics live in signupDraftStorage.ts (a
 * React-free module) so this file exports only the component - see that
 * module's header comment for why.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { SignupContext, type SignupState } from './signupContext'
import { clearSignupDraft, INITIAL_STATE, loadDraft, persistDraft } from './signupDraftStorage'
import type { RegistrationData } from './signupTypes'

export function SignupProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SignupState>(loadDraft)

  const update = useCallback((updater: (current: SignupState) => SignupState) => {
    setState((current) => {
      const next = updater(current)
      persistDraft(next)
      return next
    })
  }, [])

  const value = useMemo(
    () => ({
      state,
      saveAccount: (values: Partial<RegistrationData>) =>
        update((current) => ({
          ...current,
          started: true,
          // A (re)submitted step 1 starts a fresh registration attempt.
          completed: false,
          // Changing the e-mail invalidates a previous verification.
          emailVerified:
            values.email !== undefined && values.email !== current.data.email ? false : current.emailVerified,
          data: { ...current.data, ...values },
        })),
      markEmailVerified: () => update((current) => ({ ...current, emailVerified: true })),
      saveContract: (values: Partial<RegistrationData>) =>
        update((current) => ({ ...current, contractFilled: true, data: { ...current.data, ...values } })),
      markCompleted: () => update((current) => ({ ...current, completed: true })),
      reset: () => {
        clearSignupDraft()
        setState(INITIAL_STATE)
      },
    }),
    [state, update],
  )

  return <SignupContext.Provider value={value}>{children}</SignupContext.Provider>
}
