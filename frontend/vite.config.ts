import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { configDefaults, defineConfig } from 'vitest/config'

// The local emulator suite (docker: registrar-firebase-emulators) is
// started with `--project=demo-teamc-2026`, not the real `.firebaserc`
// project id `teamc-2026` - this dev-server proxy only ever runs against
// that emulator (there is no "production" instance of a Vite dev proxy),
// so it must use the emulator's actual project id or every /api/session/*
// call 404s against a project the Functions emulator never registered.
const FIREBASE_PROJECT_ID = 'demo-teamc-2026'
const FUNCTIONS_REGION = 'asia-northeast2'
const FUNCTIONS_EMULATOR_ORIGIN = 'http://127.0.0.1:5001'

// Repo root, one level up from this file's directory (frontend/). The
// third-party notice/license texts live at the fixed repo-root `legal/`
// path (docs/仕様/browser-ai.md §19.2, §22), outside Vite's project root,
// and ThirdPartyLicensesPage.tsx reads them at build time via `?raw`
// imports. That works unmodified for `vite build` (Rollup resolves any
// relative import against the filesystem), but the dev server's default
// `server.fs.allow` only serves files inside the project root, so without
// this it 403s `../legal/*` requests in `vite dev` / `vite preview`.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** `/api/session/<suffix>` -> the emulator's Functions HTTP function name. */
const SESSION_FUNCTION_BY_SUFFIX: Record<string, string> = {
  login: 'sessionLogin',
  logout: 'sessionLogout',
  me: 'sessionMe',
  csrf: 'issueCsrfToken',
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  server: {
    fs: {
      // Allow the dev server to read the repo-root `legal/` directory (see
      // the REPO_ROOT comment above). The project root (frontend/) is
      // always allowed regardless of this list, so this only extends
      // access to the rest of the repo.
      allow: [REPO_ROOT],
    },
    proxy: {
      // sessionLogin/sessionLogout/sessionMe/issueCsrfToken are onRequest
      // (not onCall) HTTP functions - same-origin fetch is the only way to
      // reach them, so the dev server proxies to the Functions emulator.
      '/api/session': {
        target: FUNCTIONS_EMULATOR_ORIGIN,
        changeOrigin: true,
        rewrite: (requestPath) => {
          const suffix = requestPath.replace(/^\/api\/session\//, '')
          const functionName = SESSION_FUNCTION_BY_SUFFIX[suffix]
          return functionName ? `/${FIREBASE_PROJECT_ID}/${FUNCTIONS_REGION}/${functionName}` : requestPath
        },
      },
    },
  },
  test: {
    // docs/仕様/browser-ai.md §21.3: the assistant LLM evaluation runs under
    // Playwright in headed Chromium with a real GPU and downloads ~350 MB of
    // model weights, so it is local-only (`npm run eval:assistant`) and must
    // never be swept into `npm test`. Only that one Playwright spec is
    // excluded - `e2e/assistant-eval/gate.test.ts` is pure logic and stays in
    // the vitest suite.
    exclude: [...configDefaults.exclude, 'e2e/assistant-eval/assistant-eval.spec.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Running test files as concurrent workers (the default) makes
    // Testing Library's waitFor/findBy* 1000ms default timeout flaky under
    // CPU contention - orderFlow.test.tsx/mypageFlow.test.tsx intermittently
    // failed ~14 tests under default parallelism despite being 100% green
    // both in isolation and with this setting. Serial file execution is a
    // fully reliable fix (verified: 129/129 across repeated `npm run test`
    // runs) and this suite is small enough (17 files) that the runtime cost
    // is negligible.
    fileParallelism: false,
  },
})
