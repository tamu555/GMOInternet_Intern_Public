import { describe, expect, it } from 'vitest'
import { DNS_RECIPES, applyRecipe } from './recipes'
import { DNS_RECORD_TYPES } from './dnsRecordTypes'

describe('DNS_RECIPES data integrity', () => {
  // 8 = spec §6.3.3b の初期セット、+2 = かんたんモードの easyDNS 用に追加した
  // Shopify / 独自サーバー（データ追加のみ、ロジックは変えていない）。
  it('has the 10 services (§6.3.3b の8件 + easyDNS 用の2件), with unique ids', () => {
    expect(DNS_RECIPES).toHaveLength(10)
    const ids = DNS_RECIPES.map((recipe) => recipe.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('records-mode recipes always carry records; ns-guide recipes carry a note instead', () => {
    for (const recipe of DNS_RECIPES) {
      if (recipe.mode === 'records') {
        expect(recipe.records, recipe.id).toBeDefined()
        expect(recipe.records!.length, recipe.id).toBeGreaterThan(0)
      } else {
        expect(recipe.records, recipe.id).toBeUndefined()
        expect(recipe.nsGuideNote, recipe.id).toBeTruthy()
      }
    }
  })

  it('every template record uses a valid type and MX templates have a priority', () => {
    for (const recipe of DNS_RECIPES) {
      for (const record of recipe.records ?? []) {
        expect(DNS_RECORD_TYPES).toContain(record.type)
        if (record.type === 'MX') expect(record.priority, recipe.id).toBeDefined()
      }
    }
  })

  it('every {placeholder} in a template has a matching declared input', () => {
    for (const recipe of DNS_RECIPES) {
      const declared = new Set((recipe.inputs ?? []).map((input) => input.key))
      for (const record of recipe.records ?? []) {
        for (const match of record.value.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)) {
          expect(declared.has(match[1]), `${recipe.id}: {${match[1]}}`).toBe(true)
        }
      }
    }
  })
})

describe('applyRecipe', () => {
  const githubPages = DNS_RECIPES.find((recipe) => recipe.id === 'github-pages')!
  const vercel = DNS_RECIPES.find((recipe) => recipe.id === 'vercel')!
  const cloudflare = DNS_RECIPES.find((recipe) => recipe.id === 'cloudflare')!

  it('substitutes {key} placeholders with the given inputs', () => {
    const records = applyRecipe(githubPages, { username: 'octocat' })
    expect(records).toHaveLength(5)
    expect(records.at(-1)).toEqual({ type: 'CNAME', name: 'www', value: 'octocat.github.io' })
  })

  it('returns fixed records unchanged when the recipe needs no inputs', () => {
    expect(applyRecipe(vercel, {})).toEqual([
      { type: 'A', name: '@', value: '76.76.21.21' },
      { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' },
    ])
  })

  it('yields [] for an ns-guide recipe (no records to apply)', () => {
    expect(applyRecipe(cloudflare, {})).toEqual([])
  })

  it('throws when a required input is missing or blank (defensive guard)', () => {
    expect(() => applyRecipe(githubPages, {})).toThrow(/username/)
    expect(() => applyRecipe(githubPages, { username: '   ' })).toThrow(/username/)
  })
})
