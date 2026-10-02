/**
 * Shared `GoogleAuthProvider` singleton.
 *
 * Split out of AuthProvider.tsx (which uses it for `signInWithPopup`) so
 * auth/reauth.ts (which uses the exact same instance for
 * `reauthenticateWithPopup`, §4.8 account deletion) can import it without
 * pulling a non-component export out of a component file (fast-refresh lint
 * rule react/only-export-components).
 */
import { GoogleAuthProvider } from 'firebase/auth'

export const googleProvider = new GoogleAuthProvider()
