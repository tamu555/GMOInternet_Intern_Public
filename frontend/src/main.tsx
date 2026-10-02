import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppRouter } from './app/AppRouter'
import { shouldUseMocks } from './config'
import { scheduleAssistantModelLoad } from './features/assistant/store/modelStore'
import { startAnalytics } from './firebase/analytics'
import './firebase/client'
import './styles/app.css'

/**
 * The backend for FIG.5-8 does not exist yet (TBD #10), so the mock service
 * worker has to be running before the first render - otherwise the session
 * check in AuthProvider would fire against nothing.
 */
async function enableMocking(): Promise<void> {
  if (!shouldUseMocks()) return
  const { worker } = await import('./mocks/browser')
  await worker.start({ onUnhandledRequest: 'bypass' })
}

// TODO(auth-migration): drop this shim once the real Firebase Auth
// integration signs the SDK in through the UI.
//
// `import.meta.env.DEV` is a build-time constant, so a production build turns
// this into `if (false)` and Rollup drops the dynamic import together with the
// whole devCallableAuth chunk - the fixed dev credentials must never ship.
if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
  void import('./dev/devCallableAuth')
    .then(({ ensureDevCallableAuth }) => ensureDevCallableAuth())
    .catch((error) => console.warn('[devCallableAuth] failed to start', error))
}

void enableMocking().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRouter />
    </StrictMode>,
  )
  // §6.1/§17.2: start the WebLLM model fetch from idle time, right after
  // mount, without blocking render or Callable-priority traffic. Wrapped
  // even though scheduleAssistantModelLoad() already guards internally -
  // this call must never be able to break app bootstrap.
  try {
    scheduleAssistantModelLoad()
  } catch {
    // Ignore.
  }
  // GA4 starts right after the first render, with no consent gate: it is a
  // no-op unless VITE_FIREBASE_MEASUREMENT_ID names a real property
  // (src/firebase/analytics.ts). Fire-and-forget - it never rejects, and it
  // must never delay or break mount.
  void startAnalytics()
})
