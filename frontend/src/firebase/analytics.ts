/**
 * Firebase Analytics (GA4) bootstrap.
 *
 * Operating decision: collection starts on load without a consent gate.
 * docs/仕様/browser-ai.md left "Cookie 同意の扱い" open; the answer is that GA4
 * runs unconditionally wherever it is configured at all. The single switch is
 * VITE_FIREBASE_MEASUREMENT_ID - no id, no Analytics - so local dev, the
 * emulator stack and CI collect nothing without any extra flag.
 *
 * Nothing here may break app bootstrap: every failure path resolves to null
 * instead of throwing, and the caller starts it fire-and-forget.
 */
import type { Analytics } from 'firebase/analytics'
import { analyticsMeasurementId, firebaseEmulatorEnabled } from '../config'
import { app } from './client'

let pending: Promise<Analytics | null> | null = null

async function start(): Promise<Analytics | null> {
  // No measurement id means the deployment never opted in to GA4.
  if (!analyticsMeasurementId()) return null
  // Emulator sessions are developer traffic against a demo- project; there is
  // no Analytics emulator, so anything sent here would land in the real GA4
  // property and pollute it.
  if (firebaseEmulatorEnabled()) return null

  try {
    // Loaded lazily so the Analytics SDK never enters the initial chunk of a
    // deployment that has no measurement id.
    const { getAnalytics, isSupported } = await import('firebase/analytics')
    // False in jsdom/SSR/unsupported browsers (needs cookies + IndexedDB);
    // getAnalytics() would throw in exactly those environments.
    if (!(await isSupported())) return null
    return getAnalytics(app)
  } catch (error) {
    console.warn('[analytics] GA4 initialization failed; continuing without it', error)
    return null
  }
}

/**
 * Start GA4 once per page load. Repeat calls share the first promise, so
 * StrictMode's double effect invocation cannot initialize Analytics twice.
 */
export function startAnalytics(): Promise<Analytics | null> {
  pending ??= start()
  return pending
}
