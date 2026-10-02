import { describe, expect, it } from 'vitest'
import { findPlaybook } from '../routing/playbooks'
import { ENABLED_ROUTES } from '../routing/routeManifest'
import type { GoalState, PageContext } from '../types'
import { buildSystemPrompt, SYSTEM_PROMPT_EXAMPLE_HEADING, SYSTEM_PROMPT_SECTION_ORDER } from './systemPrompt'

const CONTEXT: PageContext = { routeId: 'DNS_RECORDS', domain: 'example.com' }

/** §9.2 rows still marked 🤔/false as of this wave. */
const DISABLED_ROUTE_IDS = ['EASY_MODE', 'ORDER_STATUS', 'DNSSEC', 'DOMAIN_ORDER', 'DOMAIN_TRANSFER', 'ACCOUNT', 'HELP']

/** §12.2/§12.6: names of Callables this AI must never learn about or emit. */
const CALLABLE_NAMES = ['saveDnsRecords', 'listDnsRecords', 'updateDomain', 'searchDomains', 'resolveDns', 'sessionMe']

describe('buildSystemPrompt', () => {
  it('contains all 10 §12.5 section headings in order', () => {
    const prompt = buildSystemPrompt(CONTEXT, null)
    const indices = SYSTEM_PROMPT_SECTION_ORDER.map((heading) => prompt.indexOf(heading))
    for (const index of indices) {
      expect(index).toBeGreaterThanOrEqual(0)
    }
    const sorted = [...indices].sort((a, b) => a - b)
    expect(indices).toEqual(sorted)
  })

  it('lists every enabled RouteId under ROUTING and never a disabled one', () => {
    const prompt = buildSystemPrompt(CONTEXT, null)
    // Scoped to the ROUTING line rather than the whole prompt: the OUTPUT
    // FORMAT section legitimately lists the IntentIds, and `SETUP_DNSSEC`
    // contains the disabled RouteId `DNSSEC` as a substring. What actually
    // matters is that the model is only ever OFFERED enabled routes, which is
    // exactly what this line says.
    const routingLine = prompt.split('\n').find((line) => line.includes('次の Route ID だけを返してください'))
    expect(routingLine).toBeDefined()
    for (const route of ENABLED_ROUTES) {
      expect(routingLine).toContain(route.id)
    }
    const offeredRouteIds = routingLine!.slice(routingLine!.indexOf(':') + 1).split(',').map((id) => id.trim())
    for (const disabledId of DISABLED_ROUTE_IDS) {
      expect(offeredRouteIds).not.toContain(disabledId)
    }
    expect(offeredRouteIds).toEqual(ENABLED_ROUTES.map((route) => route.id))
  })

  it('injects the provider allowedValues for a CONNECT_WEBSITE playbook', () => {
    const playbook = findPlaybook('CONNECT_WEBSITE')
    if (!playbook) throw new Error('CONNECT_WEBSITE playbook missing from fixture data')
    const prompt = buildSystemPrompt(CONTEXT, playbook)
    expect(prompt).toContain('provider')
    for (const value of playbook.requiredSlots[0]!.allowedValues) {
      expect(prompt).toContain(value)
    }
  })

  it('instructs the model to leave slots empty when there is no playbook', () => {
    const prompt = buildSystemPrompt(CONTEXT, null)
    expect(prompt).toContain('slots: の行は空にしてください')
  })

  it('instructs the model to leave slots empty when the playbook has no requiredSlots', () => {
    const playbook = findPlaybook('EXPLAIN_DNS')
    if (!playbook) throw new Error('EXPLAIN_DNS playbook missing from fixture data')
    expect(playbook.requiredSlots).toHaveLength(0)
    const prompt = buildSystemPrompt(CONTEXT, playbook)
    expect(prompt).toContain('slots: の行は空にしてください')
  })

  it('never embeds the selected domain name in the prompt (§13.6)', () => {
    const prompt = buildSystemPrompt({ routeId: 'DNS_RECORDS', domain: 'secret-domain.example' }, null)
    expect(prompt).not.toContain('secret-domain.example')
  })

  it('renders CONTEXT values in machine key=value form, not Japanese prose (leak fix)', () => {
    // A prose rendering ("現在のページ: DOMAIN_SEARCH、ドメイン選択: false") is exactly
    // what got parroted back into a real answer ("ドメインの選択はfalseです。"). The
    // machine `key=value` form is the durable fix (§12.6: restrict output, not
    // "keep the prompt hidden") - see security/outputGuard.ts's stripContextEcho
    // for the matching output-side layer.
    const withDomain = buildSystemPrompt({ routeId: 'DNS_RECORDS', domain: 'example.com' }, null)
    expect(withDomain).toContain('current_page=DNS_RECORDS')
    expect(withDomain).toContain('has_selected_domain=true')
    expect(withDomain).not.toContain('現在のページ')
    expect(withDomain).not.toContain('ドメイン選択')

    const withoutDomain = buildSystemPrompt({ routeId: 'DOMAIN_SEARCH' }, null)
    expect(withoutDomain).toContain('current_page=DOMAIN_SEARCH')
    expect(withoutDomain).toContain('has_selected_domain=false')

    const noRoute = buildSystemPrompt({ routeId: null }, null)
    expect(noRoute).toContain('current_page=UNKNOWN')
    expect(noRoute).toContain('has_selected_domain=false')
  })

  it('contains no http:// or https:// URL', () => {
    const prompt = buildSystemPrompt(CONTEXT, findPlaybook('CONNECT_WEBSITE') ?? null)
    expect(prompt).not.toMatch(/https?:\/\//)
  })

  it('never mentions an internal Callable name', () => {
    const prompt = buildSystemPrompt(CONTEXT, findPlaybook('CONNECT_WEBSITE') ?? null)
    for (const name of CALLABLE_NAMES) {
      expect(prompt).not.toContain(name)
    }
  })

  it('prohibits code/command/config-file generation (v1.4 §33 要件11)', () => {
    const prompt = buildSystemPrompt(CONTEXT, null)
    expect(prompt).toContain('コード・コマンド・設定ファイルを書いてはいけません')
  })

  it('EXAMPLE: stays the LAST section (a v1.3 regression came from having content after it)', () => {
    const prompt = buildSystemPrompt(CONTEXT, findPlaybook('CONNECT_WEBSITE') ?? null)
    const exampleIndex = prompt.indexOf(SYSTEM_PROMPT_EXAMPLE_HEADING)
    expect(exampleIndex).toBeGreaterThan(-1)
    for (const heading of SYSTEM_PROMPT_SECTION_ORDER) {
      expect(exampleIndex).toBeGreaterThan(prompt.indexOf(heading))
    }
  })

  describe('goal summary in CONTEXT: (v1.4, design contract §2.1)', () => {
    const GOAL: GoalState = { intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' }, updatedAt: 0 }

    it('renders the intent and key=value slot pairs in machine known_so_far= form when a goal is present', () => {
      const prompt = buildSystemPrompt(CONTEXT, null, GOAL)
      expect(prompt).toContain('known_so_far=CONNECT_WEBSITE / provider=vercel')
    })

    it('leaves CONTEXT: byte-identical to today\'s output when goal is null', () => {
      const withNullGoal = buildSystemPrompt(CONTEXT, null, null)
      const withoutGoalArg = buildSystemPrompt(CONTEXT, null)
      expect(withNullGoal).toBe(withoutGoalArg)
      expect(withNullGoal).not.toContain('known_so_far')
    })

    it('leaves CONTEXT: byte-identical to today\'s output when goal is empty', () => {
      const emptyGoal: GoalState = { intent: null, slots: {}, updatedAt: 0 }
      const withEmptyGoal = buildSystemPrompt(CONTEXT, null, emptyGoal)
      const withoutGoalArg = buildSystemPrompt(CONTEXT, null)
      expect(withEmptyGoal).toBe(withoutGoalArg)
    })

    it('still triggers the §13.6 domain guard when a goal slot value equals context.domain', () => {
      const leakyGoal: GoalState = {
        intent: 'CONNECT_WEBSITE',
        slots: { keyword: 'secret-domain.example' },
        updatedAt: 0,
      }
      expect(() =>
        buildSystemPrompt({ routeId: 'DNS_RECORDS', domain: 'secret-domain.example' }, null, leakyGoal),
      ).toThrow(/context\.domain must never appear/)
    })
  })
})
