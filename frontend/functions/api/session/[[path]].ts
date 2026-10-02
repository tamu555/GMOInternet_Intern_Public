/**
 * Cloudflare Pages Function: the production counterpart of vite.config.ts's
 * `/api/session` dev-server proxy.
 *
 * WHY THIS EXISTS
 *
 * `functions/src/auth/session.ts` deploys `sessionLogin` / `sessionLogout` /
 * `sessionMe` / `issueCsrfToken` as `onRequest` handlers with `cors: false`,
 * and the session cookie they write is `HttpOnly; Secure; SameSite=Strict`.
 * Both choices assume the browser reaches them on the SAME origin as the SPA.
 * On Firebase Hosting that is exactly what firebase.json's `/api/session/*`
 * rewrites provide - but this project's frontend ships from Cloudflare Pages
 * (docs/firebase/deploy.md: the deploy pipeline is pinned to
 * `--only functions,firestore`, Hosting is never deployed), where those
 * rewrites do not exist. `/api/session/*` therefore fell through to the SPA
 * fallback and answered `index.html` with HTTP 200, which `api/sessionApi.ts`
 * read as a successful call - the single root cause behind "logged in without
 * ever registering", the blank `/domains/new` screen, and a registration that
 * created the Auth user and the Firestore profile yet still reported
 * "登録を完了できませんでした".
 *
 * WHY NOT CALL THE FUNCTIONS DIRECTLY FROM THE BROWSER
 *
 * `*.cloudfunctions.net` is a different registrable domain from the site's
 * own, so the session cookie would have to become `SameSite=None` and travel
 * as a third-party cookie: blocked outright by Safari's ITP and partitioned
 * away by Firefox's Total Cookie Protection. It would also strip the
 * `SameSite=Strict` half of the CSRF defence. Restoring the same-origin hop
 * here keeps `functions/src/auth/session.ts` unchanged.
 *
 * The suffix -> function map is a closed allowlist, mirroring
 * vite.config.ts's `SESSION_FUNCTION_BY_SUFFIX`. It must never become an open
 * proxy into the project's other deployed functions.
 */

/** Matches functions/src/config/options.ts REGION and .firebaserc's project. */
const FUNCTIONS_ORIGIN = 'https://asia-northeast2-teamc-2026.cloudfunctions.net'

/** `/api/session/<suffix>` -> the deployed HTTP function's id. */
const SESSION_FUNCTION_BY_SUFFIX: Readonly<Record<string, string>> = {
  login: 'sessionLogin',
  logout: 'sessionLogout',
  me: 'sessionMe',
  csrf: 'issueCsrfToken',
}

/**
 * Minimal shape of the Pages Functions invocation context. Declared locally
 * rather than pulled from `@cloudflare/workers-types` so this file adds no
 * dependency to frontend/package.json - it is compiled by Cloudflare's own
 * build step, not by `tsc -b` (tsconfig.app.json only includes `src`).
 */
type SessionProxyContext = {
  request: Request
  params: Record<string, string | string[] | undefined>
}

/**
 * Answered as JSON, never as the SPA shell: `api/sessionApi.ts` now rejects a
 * non-JSON body on this surface, and an unmapped suffix is a client-side bug
 * that should read as one instead of silently rendering the app again.
 */
function unknownEndpoint(): Response {
  const body = { error: { code: 'not-found', message: 'Unknown session endpoint.' } }
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function onRequest(context: SessionProxyContext): Promise<Response> {
  const { request, params } = context

  // `[[path]]` is a catch-all, so `params.path` is the segment array. Only a
  // single segment can ever match the allowlist; anything deeper is rejected
  // rather than being flattened into a matching suffix.
  const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : []
  const functionId = segments.length === 1 ? SESSION_FUNCTION_BY_SUFFIX[segments[0]] : undefined
  if (!functionId) return unknownEndpoint()

  const target = new URL(`${FUNCTIONS_ORIGIN}/${functionId}`)
  target.search = new URL(request.url).search

  // `new Request(target, request)` carries the method, the body, and every
  // header through unchanged - `Cookie` and `X-CSRF-Token` are the two that
  // matter, and the CSRF double-submit check fails closed if either is lost.
  const upstream = await fetch(new Request(target, request))

  // Rebuilt rather than returned as-is because a `fetch` Response's headers
  // are immutable in Workers, and because this is the documented pass-through
  // idiom: it preserves the status and every header, `Set-Cookie` included.
  // The cookie lands on this site's own origin, which is what keeps
  // `SameSite=Strict` workable.
  const response = new Response(upstream.body, upstream)
  // Set here rather than left to public/_headers: that file governs static
  // asset responses, and a Function's response does not reliably inherit it.
  // These four answer JSON only, so sniffing them as anything else is never
  // wanted. `Cache-Control: no-store` already arrives from the backend
  // (`setNoStore` in functions/src/auth/session.ts) and is passed through.
  response.headers.set('X-Content-Type-Options', 'nosniff')
  return response
}
