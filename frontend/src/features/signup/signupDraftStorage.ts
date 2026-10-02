/**
 * React-free sessionStorage concern for the registration wizard's draft.
 * Split out of SignupProvider.tsx (issue #85 follow-up) so callers outside
 * the wizard - AuthProvider.logout() and SignupConfirmPage's
 * post-registration handler - can import `clearSignupDraft` without pulling
 * in the `SignupProvider` component (which previously tripped
 * react/only-export-components, since a file exporting both a component and
 * plain functions breaks Fast Refresh's assumptions). Same shape as
 * clearAssistantChat() in features/assistant/store/chatStore.ts.
 */
import type { SignupState } from './signupContext'
import { EMPTY_REGISTRATION_DATA, type RegistrationData } from './signupTypes'

// v2: RegistrationData's shape changed (3-way accountType, nested
// address/business, new phone/DOB/gender/newsletter fields) - a v1 draft
// cannot satisfy the new zod schemas, so bump the key to discard it rather
// than risk mis-coercing stale data into the new shape.
const STORAGE_KEY = 'registrar.signup.draft.v2'

type StoredDraft = Omit<SignupState, 'data'> & { data: Omit<RegistrationData, 'password'> }

export const INITIAL_STATE: SignupState = {
  data: EMPTY_REGISTRATION_DATA,
  started: false,
  emailVerified: false,
  contractFilled: false,
  completed: false,
}

export function loadDraft(): SignupState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return INITIAL_STATE
    const stored = JSON.parse(raw) as StoredDraft
    return {
      ...INITIAL_STATE,
      ...stored,
      // The password is never persisted; a reload starts with it blank.
      data: { ...EMPTY_REGISTRATION_DATA, ...stored.data, password: '' },
    }
  } catch {
    return INITIAL_STATE
  }
}

export function persistDraft(state: SignupState): void {
  try {
    const { password: _password, ...dataWithoutPassword } = state.data
    const draft: StoredDraft = { ...state, data: dataWithoutPassword }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // Ignore: the in-memory state still carries this tab's input.
  }
}

/**
 * Removes the persisted draft from sessionStorage. Exported (not
 * React-bound) so callers outside the signup wizard - AuthProvider.logout()
 * and SignupConfirmPage's post-registration handler - can clear the PII
 * mirror without requiring a mounted SignupContext.Provider. See
 * clearAssistantChat() in features/assistant/store/chatStore.ts for the
 * equivalent pattern.
 */
export function clearSignupDraft(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}
