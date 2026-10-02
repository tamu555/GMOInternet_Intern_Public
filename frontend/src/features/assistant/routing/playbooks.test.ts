/**
 * Playbook-table invariants that no other suite owns: the enum slot questions
 * are generated from `allowedValues` (they used to be hand-written and drifted),
 * and `resolveRouteForSlots` reads `recipes.ts`'s own `mode` rather than a
 * hard-coded provider id.
 */
import { describe, expect, it } from 'vitest'
import { DNS_RECIPES } from '../../dns/recipes'
import {
  ASSISTANT_PLAYBOOKS,
  findPlaybook,
  providerNeedsNameserverChange,
  resolveRouteForSlots,
  slotValueDisplayName,
} from './playbooks'

describe('enum slot questions name exactly their allowedValues', () => {
  // ⚠️ Regression: CONNECT_WEBSITE's question was hand-written as
  // 「…（Vercel / Netlify / GitHub Pages / Cloudflare / その他）」 while its
  // allowedValues additionally held `sakura-rental` and `xserver`. The user
  // saw the assistant name Cloudflare and then offer さくら/エックスサーバー buttons.
  it.each(
    ASSISTANT_PLAYBOOKS.flatMap((playbook) =>
      playbook.requiredSlots
        .filter((slot) => (slot.kind ?? 'enum') === 'enum' && slot.allowedValues.length > 0)
        .map((slot) => [playbook.intent, slot] as const),
    ),
  )('%s: every allowedValue appears in the question text', (_intent, slot) => {
    for (const value of slot.allowedValues) {
      expect(slot.question).toContain(slotValueDisplayName(value))
    }
  })

  it('every enum allowedValue has a human display name (never the raw id)', () => {
    for (const playbook of ASSISTANT_PLAYBOOKS) {
      for (const slot of playbook.requiredSlots) {
        if ((slot.kind ?? 'enum') !== 'enum') continue
        for (const value of slot.allowedValues) {
          expect(slotValueDisplayName(value)).not.toBe(value)
        }
      }
    }
  })
})

describe('providerNeedsNameserverChange / resolveRouteForSlots', () => {
  it('is true for exactly the DNS_RECIPES entries marked mode: ns-guide', () => {
    for (const recipe of DNS_RECIPES) {
      expect(providerNeedsNameserverChange(recipe.id)).toBe(recipe.mode === 'ns-guide')
    }
    expect(providerNeedsNameserverChange(null)).toBe(false)
    expect(providerNeedsNameserverChange('not-a-provider')).toBe(false)
  })

  it('routes every ns-guide provider to DNS_NAMESERVER, not only the one §10.2 happened to name', () => {
    // The old override hard-coded `cloudflare`, so an `xserver` user - equally
    // `mode: 'ns-guide'` in recipes.ts - was sent to DNS_RECORDS and offered a
    // records recipe this provider has none of.
    const playbook = findPlaybook('CONNECT_WEBSITE')!
    expect(resolveRouteForSlots(playbook, { provider: 'cloudflare' })).toBe('DNS_NAMESERVER')
    expect(resolveRouteForSlots(playbook, { provider: 'xserver' })).toBe('DNS_NAMESERVER')
    expect(resolveRouteForSlots(playbook, { provider: 'vercel' })).toBe('DNS_RECORDS')
    expect(resolveRouteForSlots(playbook, {})).toBe('DNS_RECORDS')
  })
})
