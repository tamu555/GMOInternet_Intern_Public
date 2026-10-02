/**
 * Firebase client SDK initialization.
 *
 * The Functions region MUST be "asia-northeast2" - it matches
 * functions/src/config/options.ts's REGION constant (Firestore's own
 * location, per firebase.json). The SDK's getFunctions() defaults to
 * us-central1 when no region is passed, which would silently 404 every
 * httpsCallable against this project instead of erroring loudly.
 */
import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth'
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore'
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions'
import { firebaseEmulatorEnabled } from '../config'

const FUNCTIONS_REGION = 'asia-northeast2'
const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099'
const FUNCTIONS_EMULATOR_HOST = '127.0.0.1'
const FUNCTIONS_EMULATOR_PORT = 5001
const FIRESTORE_EMULATOR_HOST = '127.0.0.1'
const FIRESTORE_EMULATOR_PORT = 8080

/**
 * teamc-2026 (.firebaserc) in production; the local emulator suite is
 * started with `--project=demo-teamc-2026` (Firebase's auto-demo project
 * convention for emulator-only runs), so the default must follow the same
 * dev-vs-real gate as the emulator connection below - hardcoding the real
 * project id here would make every local emulator call target the wrong
 * project. Overridable per-environment via VITE_FIREBASE_PROJECT_ID.
 */
const PROJECT_ID =
  import.meta.env.VITE_FIREBASE_PROJECT_ID ??
  (firebaseEmulatorEnabled() ? 'demo-teamc-2026' : 'teamc-2026')

/**
 * appId and measurementId exist only for Analytics (src/firebase/analytics.ts);
 * Auth, Functions and Firestore never read them. Both stay undefined for
 * emulator and CI runs, which is exactly what keeps GA4 off there.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-api-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? `${PROJECT_ID}.firebaseapp.com`,
  projectId: PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

export const app = initializeApp(firebaseConfig)

export const auth: Auth = getAuth(app)
export const functions: Functions = getFunctions(app, FUNCTIONS_REGION)

/**
 * Firestore is reachable from the browser for exactly one thing: the signup
 * wizard's step-2 verification code (`verificationCodes/{email}`), which no
 * mail channel delivers. firestore.rules allows that single `get` and
 * nothing else. The wizard itself never renders the code; the read exists
 * for the separate retrieval path (api/signupApi.ts `fetchVerificationCode`).
 */
export const firestore: Firestore = getFirestore(app)

// Gated on firebaseEmulatorEnabled(), not the MSW mock flag: the mock flag
// only controls MSW for the leftover REST endpoints. Turning mocks off to
// exercise the real Callables must keep the SDK on the local emulators -
// otherwise every call goes to the deployed project (CORS + real quota).
if (firebaseEmulatorEnabled()) {
  connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true })
  connectFunctionsEmulator(functions, FUNCTIONS_EMULATOR_HOST, FUNCTIONS_EMULATOR_PORT)
  connectFirestoreEmulator(firestore, FIRESTORE_EMULATOR_HOST, FIRESTORE_EMULATOR_PORT)
}
