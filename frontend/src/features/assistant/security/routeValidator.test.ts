import { describe, expect, it } from 'vitest'
import type { PageContext } from '../types'
import { guardDecision, isPlaybookSatisfied } from './routeValidator'
import { findPlaybook } from '../routing/playbooks'

const VALID_CONNECT_WEBSITE_VERCEL = {
  intent: 'CONNECT_WEBSITE',
  reply: 'DNS設定のレコード設定モードから接続できます。',
  routeId: 'DNS_RECORDS',
  slots: { provider: 'vercel' },
  confidence: 0.9,
  needsClarification: false,
}

describe('guardDecision: happy path', () => {
  it('resolves a CONNECT_WEBSITE / provider=vercel decision to DNS_RECORDS at the domain-scoped path', () => {
    const context: PageContext = { routeId: null, domain: 'example.com' }
    const result = guardDecision(VALID_CONNECT_WEBSITE_VERCEL, context)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.navigation).toEqual({
      routeId: 'DNS_RECORDS',
      resolvedPath: '/domains/example.com/dns?mode=records',
      title: expect.any(String),
      description: expect.any(String),
    })
    expect(result.value.masked).toBe(false)
  })

  it('overrides the model-chosen route with the app-side slot resolution: provider=cloudflare -> DNS_NAMESERVER even though the model said DNS_RECORDS', () => {
    const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, slots: { provider: 'cloudflare' }, routeId: 'DNS_RECORDS' }
    const context: PageContext = { routeId: null, domain: 'example.com' }
    const result = guardDecision(candidate, context)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.navigation?.routeId).toBe('DNS_NAMESERVER')
    expect(result.value.decision.routeId).toBe('DNS_NAMESERVER')
  })
})

describe('guardDecision: FR-05 - never navigates outside the allowlist', () => {
  // §11.4 is explicit that an out-of-allowlist route is "dropped to null so
  // only the reply is shown" - not that the whole answer is thrown away. What
  // FR-05 actually requires is that no navigation to a disabled route is ever
  // produced, which is what these assert.
  it.each(['EASY_MODE', 'ORDER_STATUS', 'DNSSEC', 'ACCOUNT'])(
    'never produces navigation for the disabled route %s',
    (disabledRouteId) => {
      const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, routeId: disabledRouteId }
      const result = guardDecision(candidate, { routeId: null })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.decision.routeId).not.toBe(disabledRouteId)
      expect(result.value.navigation?.routeId).not.toBe(disabledRouteId)
      // Nothing anywhere in the guarded output may carry a path for it.
      expect(JSON.stringify(result.value)).not.toContain(disabledRouteId)
    },
  )

  it('drops an enabled-but-out-of-Playbook route to null: EXPLAIN_DNS never proposes DNS_RECORDS', () => {
    // DNS_RECORDS is a globally enabled route (passes decisionSchema), but
    // EXPLAIN_DNS's own Playbook.allowedRoutes is empty - the model cannot
    // pick a route this intent was never given permission to propose.
    const candidate = {
      intent: 'EXPLAIN_DNS',
      reply: 'DNSの仕組みについてご説明します。',
      routeId: 'DNS_RECORDS',
      slots: {},
      confidence: 0.9,
      needsClarification: false,
    }
    const result = guardDecision(candidate, { routeId: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.routeId).toBeNull()
    expect(result.value.navigation).toBeNull()
  })
})

describe('guardDecision: output sanitization', () => {
  it('masks a reply line that contains an IP address and reports masked: true', () => {
    // A real sentence alongside the value: a reply that is NOTHING but the
    // masking notice is now sanitized to empty and rejected instead (see
    // `isNothingButMaskNotice`), which is a different assertion from this one.
    const candidate = {
      ...VALID_CONNECT_WEBSITE_VERCEL,
      reply: 'レコード設定モードから追加できます。\nこのIPに向けてください: 76.76.21.21',
    }
    const result = guardDecision(candidate, { routeId: null, domain: 'example.com' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.masked).toBe(true)
    expect(result.value.decision.reply).not.toContain('76.76.21.21')
  })
})

describe('guardDecision: Navigation Card gating (§11.6)', () => {
  it('needsClarification: true suppresses the card even when everything else is valid', () => {
    const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, needsClarification: true }
    const result = guardDecision(candidate, { routeId: null, domain: 'example.com' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.navigation).toBeNull()
  })

  it('a missing required slot suppresses the card', () => {
    const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, slots: {} }
    const result = guardDecision(candidate, { routeId: null, domain: 'example.com' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.navigation).toBeNull()
  })

  it('confidence below the floor is rejected outright', () => {
    const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, confidence: 0.4 }
    const result = guardDecision(candidate, { routeId: null, domain: 'example.com' })
    expect(result).toEqual({ ok: false, reason: 'low_confidence' })
  })
})

describe('guardDecision: garbage input', () => {
  it.each([[{}], [null], ['not an object'], [{ url: 'https://evil.example' }]])(
    'rejects %j as schema_invalid',
    (candidate) => {
      expect(guardDecision(candidate, { routeId: null })).toEqual({ ok: false, reason: 'schema_invalid' })
    },
  )

  it('never lets an injected url field reach the sanitized decision, even attached to an otherwise-valid candidate', () => {
    const candidate = { ...VALID_CONNECT_WEBSITE_VERCEL, url: 'https://evil.example/admin' }
    const result = guardDecision(candidate, { routeId: null, domain: 'example.com' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect('url' in result.value.decision).toBe(false)
    expect(JSON.stringify(result.value)).not.toContain('evil.example')
  })
})

describe('guardDecision: §9.5 requiresDomain fallback', () => {
  it('falls back to DOMAIN_LIST at /mypage when the route needs a domain and context has none', () => {
    const result = guardDecision(VALID_CONNECT_WEBSITE_VERCEL, { routeId: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.navigation).toEqual({
      routeId: 'DOMAIN_LIST',
      resolvedPath: '/mypage',
      title: expect.any(String),
      description: expect.any(String),
    })
  })
})

describe('isPlaybookSatisfied', () => {
  const connectWebsite = findPlaybook('CONNECT_WEBSITE')!

  it('is true when the required slot has an allowed value', () => {
    expect(isPlaybookSatisfied(connectWebsite, { provider: 'vercel' })).toBe(true)
  })

  it('is false when the required slot is missing', () => {
    expect(isPlaybookSatisfied(connectWebsite, {})).toBe(false)
  })

  it('is false when the value is not in allowedValues', () => {
    expect(isPlaybookSatisfied(connectWebsite, { provider: 'not-a-real-provider' })).toBe(false)
  })

  it('is trivially true for a Playbook with no requiredSlots', () => {
    const explainDns = findPlaybook('EXPLAIN_DNS')!
    expect(isPlaybookSatisfied(explainDns, {})).toBe(true)
  })
})

/**
 * Regression guard: `decisionSchema`'s `z.enum` rejected the entire decision
 * when the model wrote an intent or route name that is not in the allowlist, so
 * a single hallucinated token threw away an otherwise good answer. §11.4 says
 * an out-of-allowlist route must be dropped to `null` and the reply still
 * shown; §10.2 gives `UNKNOWN` as the landing place for an unrecognised intent.
 */
describe('guardDecision: hallucinated enum tokens degrade instead of failing', () => {
  const CONTEXT: PageContext = { routeId: 'DOMAIN_SEARCH' }

  function candidate(overrides: Record<string, unknown>) {
    return {
      intent: 'CONNECT_WEBSITE',
      reply: 'DNS設定のレシピから設定できます。',
      routeId: 'DNS_RECORDS',
      slots: {},
      confidence: 0.9,
      needsClarification: false,
      ...overrides,
    }
  }

  it('maps an unknown intent to UNKNOWN and still shows the reply', () => {
    const result = guardDecision(candidate({ intent: 'SET_DNS_RECORD' }), CONTEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.intent).toBe('UNKNOWN')
    expect(result.value.decision.reply).toBe('DNS設定のレシピから設定できます。')
    // UNKNOWN allows no routes, so no card is offered - reply only (§11.4).
    expect(result.value.navigation).toBeNull()
  })

  it('drops an unknown route to null and still shows the reply', () => {
    const result = guardDecision(candidate({ routeId: 'DNS_SETTINGS_PAGE' }), CONTEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.routeId).toBeNull()
    expect(result.value.navigation).toBeNull()
  })

  it('accepts a lowercase / punctuated enum token from the model', () => {
    const result = guardDecision(candidate({ intent: ' connect_website ', routeId: '`dns_records`.' }), CONTEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.intent).toBe('CONNECT_WEBSITE')
    expect(result.value.decision.routeId).toBe('DNS_RECORDS')
  })

  it('never promotes an unknown token into a disabled route', () => {
    const result = guardDecision(candidate({ routeId: 'EASY_MODE' }), CONTEXT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.routeId).toBeNull()
    expect(result.value.navigation).toBeNull()
  })
})

/**
 * v1.5 §12.7: a reply that was nothing but an echoed CONTEXT value must be
 * distinguishable in the rejection reason from one that was nothing but code,
 * so the DEV diagnostic says WHY the reply vanished. The 「ドメインの選択は
 * falseです。」 leak was slow to trace precisely because every empty reply
 * looked the same in the log.
 */
describe('guardDecision: distinct reasons for an emptied reply', () => {
  const CONTEXT: PageContext = { routeId: 'DOMAIN_SEARCH' }

  function candidateWithReply(reply: string) {
    return {
      intent: 'SEARCH_DOMAIN',
      reply,
      routeId: 'DOMAIN_SEARCH',
      slots: {},
      confidence: 0.9,
      needsClarification: false,
    }
  }

  it('reports context_echo_only_reply when the whole reply was a leaked CONTEXT value', () => {
    const result = guardDecision(candidateWithReply('ドメインの選択はfalseです。'), CONTEXT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('context_echo_only_reply')
  })

  it('reports code_only_reply when the whole reply was code', () => {
    const result = guardDecision(candidateWithReply('```sh\nnpm install\n```'), CONTEXT)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('code_only_reply')
  })

  it('keeps the useful sentence when only part of the reply was a leak', () => {
    const result = guardDecision(
      candidateWithReply('ドメイン検索から始められます。ドメインの選択はfalseです。'),
      CONTEXT,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.decision.reply).toBe('ドメイン検索から始められます。')
  })
})
