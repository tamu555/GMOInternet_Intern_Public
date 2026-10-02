import { describe, expect, it } from 'vitest'
import { DNS_RECIPES } from '../../dns/recipes'
import { isIntentId } from '../routing/playbooks'
import { findRoute, isEnabledRouteId } from '../routing/routeManifest'
import { maskDnsValueLines } from '../security/outputGuard'
import {
  findWalkthroughTemplate,
  hasWalkthroughForIntent,
  templateForIntent,
  WALKTHROUGH_TEMPLATES,
  type WalkthroughId,
  type WalkthroughStep,
} from './walkthroughTemplates'

/** Every intent the plan's §3 table covers - the 11 rows, expanded to the 16 IntentIds they name. */
const COVERED_INTENTS = WALKTHROUGH_TEMPLATES.map((template) => template.intent)

describe('WALKTHROUGH_TEMPLATES existence', () => {
  it('has 16 templates (11 table rows; the domain-acquisition row and the ADD_* row each cover more than one intent)', () => {
    expect(WALKTHROUGH_TEMPLATES).toHaveLength(16)
  })

  it('every template id resolves via findWalkthroughTemplate', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      expect(findWalkthroughTemplate(template.id)).toBe(template)
    }
  })

  it('every covered intent resolves via templateForIntent, and hasWalkthroughForIntent agrees', () => {
    for (const intent of COVERED_INTENTS) {
      const resolved = templateForIntent(intent)
      expect(resolved).toBeDefined()
      expect(resolved?.intent).toBe(intent)
      expect(hasWalkthroughForIntent(intent)).toBe(true)
    }
  })

  it('an intent with no walkthrough (e.g. EXPLAIN_DNS) resolves to nothing', () => {
    expect(templateForIntent('EXPLAIN_DNS')).toBeUndefined()
    expect(hasWalkthroughForIntent('EXPLAIN_DNS')).toBe(false)
  })

  it('every template.intent is a real IntentId', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      expect(isIntentId(template.intent)).toBe(true)
    }
  })
})

describe('step shape', () => {
  it('has 3-6 steps per template', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      expect(template.steps.length).toBeGreaterThanOrEqual(3)
      expect(template.steps.length).toBeLessThanOrEqual(6)
    }
  })

  it('every title/description/label/template title is non-empty', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      expect(template.title.length).toBeGreaterThan(0)
      for (const step of template.steps) {
        expect(step.label.length).toBeGreaterThan(0)
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.description.length).toBeGreaterThan(0)
      }
    }
  })

  it('step ids are unique within each template', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      const ids = template.steps.map((step) => step.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('step ids are unique across every template (globally, not just per-template)', () => {
    const allIds = WALKTHROUGH_TEMPLATES.flatMap((template) => template.steps.map((step) => step.id))
    expect(new Set(allIds).size).toBe(allIds.length)
  })
})

/** Table-driven: every routeId any step references (completion or action) must be a real, enabled route. */
describe('route references stay inside the enabled Manifest', () => {
  const cases: { templateId: WalkthroughId; step: WalkthroughStep; source: 'completion' | 'action' }[] = []
  for (const template of WALKTHROUGH_TEMPLATES) {
    for (const step of template.steps) {
      if (step.completion.kind === 'visited-route') cases.push({ templateId: template.id, step, source: 'completion' })
      if (step.action?.kind === 'NAVIGATE') cases.push({ templateId: template.id, step, source: 'action' })
    }
  }

  it('found at least one route-backed step to check (sanity)', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$templateId / $step.id ($source) points at an enabled route', ({ step, source }) => {
    const routeId = source === 'completion' ? (step.completion as { kind: 'visited-route'; routeId: string }).routeId : step.action?.routeId
    expect(routeId).toBeDefined()
    expect(isEnabledRouteId(routeId as string)).toBe(true)
    expect(findRoute(routeId as string as never)?.enabled).toBe(true)
  })

  it('never references DOMAIN_ORDER (disabled per §9.2 - the plan explicitly routes "申し込む" through DOMAIN_SEARCH instead)', () => {
    for (const { routeId } of cases.map(({ step, source }) => ({
      routeId:
        source === 'completion' ? (step.completion as { kind: 'visited-route'; routeId: string }).routeId : step.action?.routeId,
    }))) {
      expect(routeId).not.toBe('DOMAIN_ORDER')
    }
  })
})

/**
 * ⚠️ Both "choose a service" steps used to name a hand-written excerpt of the
 * recipes (「Vercel / Netlify / GitHub Pages / Cloudflare など」 - 4 of the 8 web
 * entries). A user publishing on さくらのレンタルサーバ or Shopify read a list their
 * own service was missing from, with no way to know a recipe existed for it -
 * the same drift 決定40(b) removed from the Playbook slot question.
 */
describe('the "choose a service" steps name every recipe, generated from DNS_RECIPES', () => {
  const CASES = [
    { templateId: 'CONNECT_WEBSITE', stepId: 'connect-website-choose-provider', category: 'web' },
    { templateId: 'SETUP_EMAIL', stepId: 'setup-email-choose-provider', category: 'mail' },
  ] as const

  it.each(CASES)('$templateId names all $category recipes', ({ templateId, stepId, category }) => {
    const step = findWalkthroughTemplate(templateId)?.steps.find((candidate) => candidate.id === stepId)
    if (!step) throw new Error(`${stepId} not found`)
    const services = DNS_RECIPES.filter((recipe) => recipe.category === category).map((recipe) => recipe.service)
    for (const service of services) {
      expect(step.description, `${service} missing from ${stepId}`).toContain(service)
    }
    // The count in the copy has to match the list it introduces.
    expect(step.description).toContain(`次の${services.length}つ`)
  })

  it('never names a service this app has no recipe for', () => {
    // The other direction: a stale hand-written name would be just as wrong as a
    // missing one. Checked against a recipe id that deliberately is NOT in the
    // registry.
    const step = findWalkthroughTemplate('CONNECT_WEBSITE')?.steps.find(
      (candidate) => candidate.id === 'connect-website-choose-provider',
    )
    expect(step?.description).not.toContain('Heroku')
  })
})

describe('CHANGE_NAMESERVER carries the §6.3.3 mandatory warning', () => {
  it('warns about both DNS records no longer applying and mail stopping', () => {
    const template = findWalkthroughTemplate('CHANGE_NAMESERVER')
    expect(template).toBeDefined()
    const allWarnings = template?.steps.flatMap((step) => step.warnings ?? []) ?? []
    const combined = allWarnings.join(' ')
    expect(combined).toContain('レコード')
    expect(combined).toContain('メール')
    // The warning must appear before the user is asked to actually change anything.
    const firstStepWarnings = template?.steps[0]?.warnings ?? []
    expect(firstStepWarnings.join(' ')).toContain('レコード')
    expect(firstStepWarnings.join(' ')).toContain('メール')
  })
})

describe('no template text is DNS-value-shaped (§8.2/FR-16)', () => {
  it('maskDnsValueLines leaves every title/description/warning/template-title unchanged', () => {
    for (const template of WALKTHROUGH_TEMPLATES) {
      expect(maskDnsValueLines(template.title)).toBe(template.title)
      for (const step of template.steps) {
        expect(maskDnsValueLines(step.label)).toBe(step.label)
        expect(maskDnsValueLines(step.title)).toBe(step.title)
        expect(maskDnsValueLines(step.description)).toBe(step.description)
        for (const warning of step.warnings ?? []) {
          expect(maskDnsValueLines(warning)).toBe(warning)
        }
      }
    }
  })
})

describe('the five ADD_*_RECORD templates are structurally identical apart from the record type', () => {
  const addRecordIds: WalkthroughId[] = ['ADD_A_RECORD', 'ADD_AAAA_RECORD', 'ADD_CNAME', 'ADD_TXT', 'ADD_MX']
  const recordLabels: Record<string, string> = {
    ADD_A_RECORD: 'Aレコード',
    ADD_AAAA_RECORD: 'AAAAレコード',
    ADD_CNAME: 'CNAMEレコード',
    ADD_TXT: 'TXTレコード',
    ADD_MX: 'MXレコード',
  }

  it('all five exist with 4 steps each', () => {
    for (const id of addRecordIds) {
      const template = findWalkthroughTemplate(id)
      expect(template).toBeDefined()
      expect(template?.steps).toHaveLength(4)
    }
  })

  it('the step shape (completion kind + action kind, per position) matches across all five', () => {
    const shapes = addRecordIds.map((id) => {
      const template = findWalkthroughTemplate(id)
      return template?.steps.map((step) => ({ completionKind: step.completion.kind, actionKind: step.action?.kind ?? null }))
    })
    const [first, ...rest] = shapes
    for (const shape of rest) {
      expect(shape).toEqual(first)
    }
  })

  it('the record label is substituted consistently into title/steps, and only the label differs', () => {
    for (const id of addRecordIds) {
      const template = findWalkthroughTemplate(id)
      const label = recordLabels[id]
      expect(template?.title).toBe(`${label}を追加する`)
      // Strip the record label out of every description; what remains should be identical across all five.
      const normalized = template?.steps.map((step) => step.description.split(label).join('{RECORD}'))
      const vercel = findWalkthroughTemplate('ADD_A_RECORD')?.steps.map((step) =>
        step.description.split(recordLabels.ADD_A_RECORD).join('{RECORD}'),
      )
      expect(normalized).toEqual(vercel)
    }
  })
})
