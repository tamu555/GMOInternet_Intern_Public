/**
 * §9.4 Manifest 整合性テスト (FR-15): pathTemplate の安全規則と、
 * `enabled: true` の各ルートが AppRouter の実ルートにマッチすることを検証する。
 *
 * "Matches a real AppRouter route" approach: `AppRouter.tsx` does not export
 * its `RouteObject[]` (and is owned by another wave, not to be edited here),
 * so `react-router`'s `matchRoutes` cannot be driven against it directly.
 * Instead this renders the real `<AppRouter/>` with `window.history.pushState`
 * set to each enabled route's resolved path and asserts that NotFoundPage's
 * distinctive text ("ページが見つかりません") is NOT rendered. Guarded routes
 * correctly show a loading state or redirect to /login instead of mounting
 * the page component - that still proves the path matched a real `<Route>`
 * pattern (the catch-all `*` never fired), so this test does not authenticate
 * - only the "not the 404 page" assertion is meaningful here.
 *
 * JSX is intentionally avoided (createElement instead) so this file can stay
 * a plain `.ts` per this wave's file list, not `.tsx`.
 */
import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRouter } from '../../../app/AppRouter'
import { server } from '../../../mocks/server'
import { installSessionFetchMock } from '../../../mocks/sessionFetchMock'
import { isSafePathTemplate, resolveRoutePath } from './manifestResolver'
import { ALLOWED_ROUTE_IDS, ASSISTANT_ROUTES, ENABLED_ROUTES } from './routeManifest'

vi.mock('../../../api/callable', async () => {
  const { fakeInvoke } = await import('../../../test/fakeBackend')
  return { invoke: fakeInvoke }
})

const NOT_FOUND_TEXT = 'ページが見つかりません'
/** Seeded in test/fakeBackend.ts - every ':domainName' substitution below uses this. */
const SAMPLE_DOMAIN = 'teamc-demo.com'

function renderAppAt(path: string) {
  window.history.pushState({}, '', path)
  return render(createElement(AppRouter))
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  installSessionFetchMock()
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  vi.restoreAllMocks()
})

describe('ASSISTANT_ROUTES', () => {
  it('has no duplicate RouteId values', () => {
    const ids = ASSISTANT_ROUTES.map((route) => route.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ALLOWED_ROUTE_IDS contains exactly the enabled RouteIds', () => {
    expect(new Set(ALLOWED_ROUTE_IDS)).toEqual(new Set(ENABLED_ROUTES.map((route) => route.id)))
    expect(ALLOWED_ROUTE_IDS.length).toBe(ENABLED_ROUTES.length)
  })

  it('every non-empty pathTemplate satisfies the §9.4 safety rules', () => {
    const templatesWithoutAPage = ASSISTANT_ROUTES.filter((route) => route.pathTemplate === '')
    // DNSSEC / DOMAIN_TRANSFER / ACCOUNT / HELP: no page exists yet (§9.2 "—").
    expect(templatesWithoutAPage.map((route) => route.id).sort()).toEqual(
      ['ACCOUNT', 'DNSSEC', 'DOMAIN_TRANSFER', 'HELP'].sort(),
    )
    for (const route of ASSISTANT_ROUTES) {
      if (route.pathTemplate === '') continue
      expect(isSafePathTemplate(route.pathTemplate)).toBe(true)
    }
  })

  it.each(ENABLED_ROUTES.map((route) => [route.id, route] as const))(
    '%s pathTemplate matches a real AppRouter route (not the 404 page)',
    async (_id, route) => {
      const path = resolveRoutePath(route, { routeId: null, domain: SAMPLE_DOMAIN })
      expect(path).not.toBeNull()

      renderAppAt(path as string)
      // Lets AuthProvider's mount-time session check settle under act() before
      // asserting, instead of leaving a dangling state update for later.
      await act(async () => {})

      expect(screen.queryByText(NOT_FOUND_TEXT)).not.toBeInTheDocument()
    },
  )
})
