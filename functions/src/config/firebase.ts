/**
 * Lazily initialised Admin SDK handles.
 *
 * firestore.rules denies every client write and every client read except a
 * single `get` on `verificationCodes/{email}` (the signup wizard's step-2
 * code, which has no mail channel to travel over), so the Admin SDK is
 * effectively the only way into the database
 * (docs/api-flow-diagrams.html, header notices).
 */
import {getApps, initializeApp, type App} from "firebase-admin/app";
import {getAuth, type Auth} from "firebase-admin/auth";
import {getFirestore, Firestore} from "firebase-admin/firestore";

let firebaseApp: App | undefined;
let auth: Auth | undefined;
let firestore: Firestore | undefined;

/**
 * Returns the shared Admin SDK app, initialising it on first use.
 *
 * Under the Functions emulator, `firebase-admin`'s Cloud Tasks helper
 * (`getFunctions().taskQueue().enqueue()`, used by requestAccountDeletion)
 * resolves the OIDC token's service account email by first trying the real
 * GCE metadata server - unreachable here - before falling back to its own
 * emulated default, and that first attempt hangs until the SDK's own ~60s
 * timeout instead of failing fast. Passing `serviceAccountId` short-circuits
 * that lookup with a value already in memory, skipping the network call
 * entirely; production deployments never set FUNCTIONS_EMULATOR and resolve
 * the real service account normally.
 *
 * @return {App} Shared Admin SDK app.
 */
function app(): App {
  if (!firebaseApp) {
    const emulatorOptions = process.env.FUNCTIONS_EMULATOR === "true" ?
      {serviceAccountId: "emulated-service-acct@email.com"} :
      {};
    firebaseApp = getApps()[0] ?? initializeApp(emulatorOptions);
  }
  return firebaseApp;
}

/**
 * Returns the shared Firestore handle, initialising the app on first use.
 *
 * @return {Firestore} Admin SDK Firestore instance.
 */
export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(app());
  }
  return firestore;
}

/**
 * Returns the shared Admin Auth handle, initialising the app on first use.
 *
 * @return {Auth} Admin SDK Auth instance.
 */
export function adminAuth(): Auth {
  if (!auth) {
    auth = getAuth(app());
  }
  return auth;
}

/** Firestore collection names, in one place so they cannot drift. */
export const COLLECTIONS = {
  users: "users",
  verificationCodes: "verificationCodes",
  orders: "orders",
  domains: "domains",
  registryContacts: "registryContacts",
  registryHosts: "registryHosts",
  dnsZones: "dnsZones",
  registryLogs: "registryLogs",
  transfers: "transfers",
  pollMessages: "pollMessages",
  counters: "counters",
  watches: "watches",
} as const;
