/**
 * Playwright configuration for the assistant LLM-quality evaluation harness
 * (spec browser-ai.md §21.3). This is the ONLY Playwright config in the
 * repo; it drives `e2e/assistant-eval/assistant-eval.spec.ts` against a
 * real WebLLM/WebGPU inference in a real Chromium window.
 *
 * *** LOCAL-ONLY - NOT WIRED INTO CI OR `npm test` ***
 * §21.3: "CI ランナーには GPU がないため評価はローカル実行専用とし、通常の
 * `vitest` には含めない". `npm test` (`vitest run`) never touches this
 * config or `*.spec.ts` files - only `*.test.ts(x)` (see `vite.config.ts`'s
 * default `test.include`, which this repo has not customized). Run this
 * suite explicitly with `npm run eval:assistant` on a machine with a real
 * GPU. Do not add a `playwright.yml` workflow or reference this file from
 * any CI job.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * Fixed dev-server port so the config, the webServer block below, and a
 * developer's browser all agree on where the app is - `vite dev`'s default
 * port (5173) would also work, but pinning it here means a stray `vite`
 * already running on a different port can't silently make Playwright talk
 * to the wrong app.
 */
const DEV_SERVER_PORT = 5173
/**
 * ⚠️ `localhost`, NOT `127.0.0.1`. Vite's dev server binds the `localhost`
 * hostname, which on a dual-stack machine resolves to IPv6 `::1` - so a probe
 * against the IPv4 literal never answers even while the server is up and
 * serving. Measured symptom: with a dev server already running (which
 * `reuseExistingServer: true` below exists to take advantage of), the health
 * check failed, Playwright started a SECOND `npm run dev`, that one could not
 * bind the port either, and the run died after an opaque two-minute
 * `Timed out waiting 120000ms from config.webServer` with nothing pointing at
 * the cause. Probing the same hostname the server binds makes reuse work.
 */
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

/**
 * §21.3/§6.5: a Chromium launch flag list shared between this config and
 * `assistant-eval.spec.ts`. It lives here (not duplicated in the spec)
 * because the spec needs the exact same flags when it opens its own
 * *persistent* context - see the `userDataDir`/persistence note below - and
 * `@playwright/test`'s per-project `use.launchOptions` only applies to the
 * default (non-persistent) `context`/`page` fixtures, not to a context a
 * spec opens itself via `chromium.launchPersistentContext()`.
 */
export const CHROMIUM_LAUNCH_ARGS = [
  // Chromium gates the WebGPU API behind this flag on many channels/OSes
  // even when the underlying GPU/driver supports it - without it
  // `navigator.gpu` can be undefined and the app falls straight into
  // ModelStatus 'UNSUPPORTED' (§6.2), which would make every eval case
  // fail for a reason that has nothing to do with the assistant itself.
  '--enable-unsafe-webgpu',
  // Enables the Vulkan backend for ANGLE/Dawn (Chromium's GPU command
  // translation layer) on platforms where WebGPU's default backend needs
  // it explicitly enabled - chiefly Linux (and Windows in some
  // configurations). On macOS, WebGPU runs on Metal via Dawn and does not
  // need this flag; it is included anyway because it is a no-op there
  // (Dawn simply never selects an unused Vulkan backend on macOS) and
  // keeps this config portable to a Linux dev machine without a second,
  // platform-specific config file.
  '--enable-features=Vulkan',
]

/**
 * §21.3/§6.5: a persistent Chromium profile directory so the IndexedDB
 * model cache (§6.5) survives between `npm run eval:assistant` invocations
 * - without this, every run would re-download the ~350 MB model (§5.1).
 *
 * `@playwright/test`'s built-in `context`/`page` fixtures always call
 * `browser.newContext()` on an ephemeral, in-memory browser instance - there
 * is no config option to make the *default* fixtures persistent. The
 * documented way to get a persistent profile under the `@playwright/test`
 * runner is for the spec itself to override the `context` fixture with
 * `chromium.launchPersistentContext(userDataDir, launchOptions)` (see
 * `assistant-eval.spec.ts`'s `test.extend`) - `userDataDir` alone is not a
 * recognized key under `use`/`launchOptions` in `defineConfig()`, so it is
 * exported from here instead of set in the config object below.
 */
export const PERSISTENT_USER_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '.playwright-assistant-eval-profile',
)

/**
 * §21.3/§5.1: `assistant-eval.spec.ts` runs all 500 dataset cases inside ONE
 * Playwright test (so the model loads exactly once, §15.6), so this is not
 * just a "load the page" timeout - it has to cover the whole run:
 *
 *   - Cold model download (first run on a fresh `userDataDir` only): ~350 MB
 *     (335.2 MiB weights + 5.3 MiB WASM, §5.1) - budget 10 min on a
 *     realistic broadband connection. Warm runs (model already in the
 *     persisted profile's IndexedDB, see `PERSISTENT_USER_DATA_DIR` below)
 *     only pay `hasModelInCache` + INITIALIZING, which is seconds.
 *   - 500 sequential chat turns against a real 0.6B-class model
 *     (`maxTokens: 384`, §14.2) plus the page navigation/UI-settling work
 *     around each one - budget ~15s/case average (small model, short
 *     replies, but WebGPU inference + streaming + DOM assertions all add
 *     up) = ~125 min for the full dataset.
 *
 * Total budget: 10 + 125 = ~135 min, rounded up to 3 hours for headroom
 * (slower hardware, a few cases legitimately hitting the §16 60s per-message
 * generation timeout, etc.). If a real run still times out at this ceiling,
 * that is itself a signal worth investigating (e.g. a stuck generation) -
 * raise this constant rather than silently retrying.
 */
const PER_TEST_TIMEOUT_MS = 3 * 60 * 60 * 1000

/**
 * §17.2: the dev server itself must be reachable before Playwright starts
 * polling `/`, and *before* the app's own `requestIdleCallback` model
 * download kicks in - a slow `npm run dev` cold start (Vite optimizing
 * deps, transforming the whole assistant feature tree, etc.) must not race
 * against Playwright's own default (much shorter) webServer timeout.
 */
const WEB_SERVER_STARTUP_TIMEOUT_MS = 2 * 60 * 1000

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  // §15.6 / §5.1: one browser profile, one WebLLM Engine, one model in GPU
  // memory. Parallel workers would either contend for the same GPU or each
  // pay their own 350 MB download - neither is what this suite wants.
  workers: 1,
  fullyParallel: false,
  // A flaky retry would silently mask a real §21.4 gate regression as
  // "passed on the second try" - this harness's whole job is to be an
  // honest, deterministic-as-possible signal, so it never auto-retries.
  retries: 0,

  timeout: PER_TEST_TIMEOUT_MS,

  reporter: [['list'], ['json', { outputFile: 'e2e/assistant-eval/report.json' }]],

  webServer: {
    command: 'npm run dev',
    url: DEV_SERVER_URL,
    // The model download starts as soon as the app loads (§6.1: "ページ
    // アクセス時点からモデル取得を開始する"), so the dev server must be up
    // and serving before Playwright ever navigates - reuseExistingServer
    // also lets a developer keep their own `npm run dev` running and just
    // re-run `npm run eval:assistant` repeatedly without a server restart
    // between runs (which would otherwise interrupt an in-flight download).
    reuseExistingServer: true,
    timeout: WEB_SERVER_STARTUP_TIMEOUT_MS,
  },

  use: {
    baseURL: DEV_SERVER_URL,
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // §21.3: "headed Chromium（WebGPU 有効）" - WebGPU device pickers
        // and some driver paths behave differently (and less reliably)
        // headless, so this suite deliberately runs with a visible window.
        headless: false,
        // Applies to the default (non-persistent) `context`/`page`
        // fixtures. `assistant-eval.spec.ts` does not use those - it opens
        // its own persistent context (see `PERSISTENT_USER_DATA_DIR`
        // above) and passes `CHROMIUM_LAUNCH_ARGS` there directly - but
        // this is kept in sync so `--list` / any future spec added under
        // `e2e/` that *does* use the default fixtures still gets WebGPU.
        launchOptions: {
          args: CHROMIUM_LAUNCH_ARGS,
        },
      },
    },
  ],
})
