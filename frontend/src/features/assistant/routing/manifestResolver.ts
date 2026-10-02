/**
 * Turns a `RouteId` chosen by the AI into an internal path the app can
 * actually `navigate()` to (spec §9.3/§9.5). The AI never sees or emits a
 * path/URL - only these functions, driven by the compile-time Manifest, are
 * allowed to build one.
 */
import type { NavigationSuggestion, PageContext } from '../types'
import type { AssistantRoute, RouteId } from './routeManifest'
import { ENABLED_ROUTES, findRoute } from './routeManifest'

/**
 * §9.4 bullet 1's three rules, applied to `pathTemplate`. Deliberately NOT a
 * call to `auth/returnTo.ts`'s `isSafeReturnPath()`: that function also
 * excludes `/login` and `/register` (`EXCLUDED_PREFIXES`, because they would
 * bounce a post-login redirect back to itself), which would wrongly reject
 * the Manifest's own `LOGIN` route. Only the three general safety rules
 * apply here.
 */
export function isSafePathTemplate(pathTemplate: string): boolean {
  if (!pathTemplate.startsWith('/')) return false
  if (pathTemplate.startsWith('//')) return false
  // A scheme ("javascript:", "https:", ...) right after the leading slash
  // would let a crafted template escape the same-origin SPA route space.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(pathTemplate.slice(1))) return false
  return true
}

export function routePathWithoutQuery(pathTemplate: string): string {
  const queryIndex = pathTemplate.indexOf('?')
  return queryIndex === -1 ? pathTemplate : pathTemplate.slice(0, queryIndex)
}

/**
 * §9.3/§9.5. Substitutes ':domainName' with `encodeURIComponent(context.domain)`
 * (same pattern as `DomainDetailPage.tsx`'s `/dns` link) when the route needs
 * one, returns `null` when it needs one but none is available (caller falls
 * back to DOMAIN_LIST - see `resolveNavigation`), and otherwise returns the
 * template unchanged. Never returns a path with an unsubstituted ':domainName'.
 */
export function resolveRoutePath(route: AssistantRoute, context: PageContext): string | null {
  if (!route.requiresDomain) return route.pathTemplate
  if (!context.domain) return null
  return route.pathTemplate.replace(':domainName', encodeURIComponent(context.domain))
}

/**
 * §9.5 + §7.6: resolves a chosen RouteId into a card-ready suggestion. Falls
 * back to DOMAIN_LIST when the route needs a domain and `context.domain` is
 * absent (the caller appends the §9.5 reply sentence -
 * `assistantMessages.ts`'s `DOMAIN_SELECTION_REQUIRED`). Returns `null` when
 * the route does not exist or is disabled.
 */
export function resolveNavigation(routeId: RouteId, context: PageContext): NavigationSuggestion | null {
  const route = findRoute(routeId)
  if (!route || !route.enabled) return null

  const resolvedPath = resolveRoutePath(route, context)
  if (resolvedPath !== null) {
    return { routeId: route.id, resolvedPath, title: route.title, description: route.description }
  }

  const fallback = findRoute('DOMAIN_LIST')
  if (!fallback || !fallback.enabled) return null
  const fallbackPath = resolveRoutePath(fallback, context)
  if (fallbackPath === null) return null
  return { routeId: fallback.id, resolvedPath: fallbackPath, title: fallback.title, description: fallback.description }
}

function nonEmptySegments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

function pathMatchesTemplate(pathname: string, pathTemplate: string): boolean {
  const templateSegments = nonEmptySegments(routePathWithoutQuery(pathTemplate))
  const actualSegments = nonEmptySegments(pathname)
  if (templateSegments.length !== actualSegments.length) return false
  return templateSegments.every((segment, index) =>
    segment === ':domainName' ? actualSegments[index].length > 0 : segment === actualSegments[index],
  )
}

function searchMatchesTemplate(search: string, pathTemplate: string): boolean {
  const queryIndex = pathTemplate.indexOf('?')
  if (queryIndex === -1) return true
  const templateParams = new URLSearchParams(pathTemplate.slice(queryIndex + 1))
  const actualParams = new URLSearchParams(search)
  for (const [key, value] of templateParams) {
    if (actualParams.get(key) !== value) return false
  }
  return true
}

/**
 * Reverse lookup for `PageContext.routeId` (§13.6) and the `route_changed`
 * event (§20.1). Only matches against ENABLED_ROUTES. ':domainName' matches
 * exactly one non-empty, non-'/' segment. A route whose template carries a
 * query string (e.g. '?mode=records') only matches when `search` carries the
 * same key=value. Returns `null` when nothing matches.
 */
export function routeIdForPath(pathname: string, search: string): RouteId | null {
  for (const route of ENABLED_ROUTES) {
    if (!route.pathTemplate) continue
    if (pathMatchesTemplate(pathname, route.pathTemplate) && searchMatchesTemplate(search, route.pathTemplate)) {
      return route.id
    }
  }
  return null
}
