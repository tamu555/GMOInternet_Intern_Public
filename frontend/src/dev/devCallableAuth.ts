/**
 * Dev-only sign-in shim for the Firebase emulator.
 *
 * Every implemented callable requires request.auth, but the real Firebase Auth
 * integration is owned by the auth workstream and has not landed yet - the UI
 * session is still the MSW token model. Until then this shim quietly signs the
 * Firebase SDK in as a fixed dev user so callables work at all. The two
 * sessions are independent by design.
 *
 * TODO(auth-migration): remove this shim now that the real Firebase Auth
 * integration has landed (src/auth/AuthProvider.tsx, src/api/authApi.ts) -
 * it only still matters for tests/dev sessions that exercise domains/orders/
 * mypage/DNS callables without going through the real login UI first.
 */
import { FirebaseError } from 'firebase/app'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { invoke } from '../api/callable'
import { fetchVerificationCode, startSignup, verifySignupCode } from '../api/signupApi'
import { firebaseEmulatorEnabled } from '../config'
import { auth as firebaseAuth } from '../firebase/client'

const DEV_EMAIL = 'dev@example.com'
const DEV_PASSWORD = 'dev-password-123'

function isMissingUser(error: unknown): boolean {
  return (
    error instanceof FirebaseError &&
    (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential')
  )
}

export async function ensureDevCallableAuth(): Promise<void> {
  // Second, independent guard: main.tsx already strips this module from production
  // builds, but this shim signs in as a fixed, publicly known account - it must
  // stay inert even if some other caller reaches it in a production bundle.
  if (import.meta.env.PROD) return
  if (!firebaseEmulatorEnabled()) return
  if (firebaseAuth.currentUser) return

  try {
    await signInWithEmailAndPassword(firebaseAuth, DEV_EMAIL, DEV_PASSWORD)
  } catch (error) {
    if (!isMissingUser(error)) {
      console.warn('[devCallableAuth] emulator sign-in failed; callables will be unauthenticated', error)
      return
    }
    try {
      // registerWithEmailPassword refuses any address without a live
      // verification grant (server-side email-verification precondition,
      // .agents/docs/DESIGN.md 2026-08-26), so the shim walks the same
      // sanctioned path the signup wizard uses: issue a code, read it back
      // from `verificationCodes/{email}` (the one supported client read),
      // and verify it before registering.
      await startSignup({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        name: 'Test User',
        nameKana: 'テスト ユーザー',
      })
      const code = await fetchVerificationCode(DEV_EMAIL)
      if (!code) {
        console.warn(
          '[devCallableAuth] could not read the dev verification code; is the Firestore emulator running?',
        )
        return
      }
      await verifySignupCode({ email: DEV_EMAIL, code })
      // Per docs/仕様/auth.md the client never calls createUserWithEmailAndPassword;
      // account creation goes through the backend callable. Full profile
      // shape matches profileSchema.ts's registrationInputSchema - the old
      // flat {name, address} payload predates the full-profile registration
      // feature and now fails validation.
      await invoke('registerWithEmailPassword', {
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        name: 'Test User',
        nameKana: 'テスト ユーザー',
        phoneNumber: '090-0000-0000',
        dateOfBirth: '1990-01-01',
        gender: 'no_answer',
        newsletterOptIn: false,
        accountType: 'individual',
        business: null,
        address: {
          country: 'JP',
          postalCode: '100-0001',
          prefecture: '東京都',
          city: 'Dev City',
          addressLine: '1-2-3',
          building: null,
        },
      })
      await signInWithEmailAndPassword(firebaseAuth, DEV_EMAIL, DEV_PASSWORD)
    } catch (registerError) {
      console.warn(
        '[devCallableAuth] dev user setup failed; is the emulator running? (docs/firebase: docker compose up)',
        registerError,
      )
    }
  }
}
