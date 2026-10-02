import { describe, expect, it } from 'vitest'
import type { PageContext } from '../types'
import {
  isSafePathTemplate,
  resolveNavigation,
  resolveRoutePath,
  routeIdForPath,
  routePathWithoutQuery,
} from './manifestResolver'
import { findRoute, type RouteId } from './routeManifest'

describe('isSafePathTemplate', () => {
  it('accepts a normal app-internal path', () => {
    expect(isSafePathTemplate('/mypage/domains/:domainName')).toBe(true)
  })

  it('rejects a path without a leading slash', () => {
    expect(isSafePathTemplate('mypage')).toBe(false)
  })

  it('rejects a protocol-relative path ("//")', () => {
    expect(isSafePathTemplate('//evil.example')).toBe(false)
  })

  it('rejects a path that carries a scheme right after the leading slash', () => {
    expect(isSafePathTemplate('/https://evil.example')).toBe(false)
    expect(isSafePathTemplate('/javascript:alert(1)')).toBe(false)
  })

  it('accepts the LOGIN route, unlike isSafeReturnPath()', () => {
    // §9.4: intentionally not reusing auth/returnTo.ts's isSafeReturnPath(),
    // whose EXCLUDED_PREFIXES would reject '/login'.
    expect(isSafePathTemplate('/login')).toBe(true)
  })
})

describe('routePathWithoutQuery', () => {
  it('strips the query string', () => {
    expect(routePathWithoutQuery('/domains/:domainName/dns?mode=records')).toBe('/domains/:domainName/dns')
  })

  it('returns the template unchanged when there is no query', () => {
    expect(routePathWithoutQuery('/mypage')).toBe('/mypage')
  })
})

describe('resolveRoutePath', () => {
  const dnsRecords = findRoute('DNS_RECORDS')!

  it('substitutes :domainName when a domain is available', () => {
    const context: PageContext = { routeId: null, domain: 'example.com' }
    expect(resolveRoutePath(dnsRecords, context)).toBe('/domains/example.com/dns?mode=records')
  })

  it('encodeURIComponent-encodes a domain containing a slash', () => {
    const context: PageContext = { routeId: null, domain: 'a/b.com' }
    expect(resolveRoutePath(dnsRecords, context)).toBe('/domains/a%2Fb.com/dns?mode=records')
  })

  it('returns null when the route needs a domain and none is available', () => {
    const context: PageContext = { routeId: null }
    expect(resolveRoutePath(dnsRecords, context)).toBeNull()
  })

  it('returns the template unchanged for a route that does not need a domain', () => {
    const domainList = findRoute('DOMAIN_LIST')!
    expect(resolveRoutePath(domainList, { routeId: null })).toBe('/mypage')
  })
})

describe('resolveNavigation', () => {
  it('resolves a domain-scoped route when a domain is selected', () => {
    const suggestion = resolveNavigation('DNS_RECORDS', { routeId: null, domain: 'example.com' })
    expect(suggestion?.routeId).toBe('DNS_RECORDS')
    expect(suggestion?.resolvedPath).toBe('/domains/example.com/dns?mode=records')
  })

  it('falls back to DOMAIN_LIST when a domain-scoped route has no domain', () => {
    const suggestion = resolveNavigation('DNS_RECORDS', { routeId: null })
    expect(suggestion?.routeId).toBe('DOMAIN_LIST')
    expect(suggestion?.resolvedPath).toBe('/mypage')
  })

  it('returns null for a disabled route', () => {
    expect(resolveNavigation('DNSSEC', { routeId: null })).toBeNull()
  })

  it('returns null for an unknown route id', () => {
    expect(resolveNavigation('NOT_A_ROUTE' as RouteId, { routeId: null })).toBeNull()
  })
})

describe('routeIdForPath', () => {
  it.each([
    ['/', '', 'DOMAIN_SEARCH'],
    ['/mypage', '', 'DOMAIN_LIST'],
    ['/mypage/domains/x.com', '', 'DOMAIN_DETAIL'],
    ['/domains/x.com/dns', '?mode=records', 'DNS_RECORDS'],
    ['/domains/x.com/dns', '?mode=ns', 'DNS_NAMESERVER'],
    ['/domains/x.com/dns', '', null],
    ['/unknown', '', null],
  ] as const)('routeIdForPath(%j, %j) -> %j', (pathname, search, expected) => {
    expect(routeIdForPath(pathname, search)).toBe(expected)
  })
})
