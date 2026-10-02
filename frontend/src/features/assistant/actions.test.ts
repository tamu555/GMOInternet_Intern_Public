import { describe, expect, it } from 'vitest'
import { deriveActions, fallbackActions, MAX_ACTIONS_PER_MESSAGE, purposeShortcutActions, SLOT_VALUE_DISPLAY_NAMES } from './actions'
import {
  NEXT_STEP_CONNECT_WEBSITE_LABEL,
  NEXT_STEP_EXPLAIN_DNS_LABEL,
  NEXT_STEP_SETUP_EMAIL_LABEL,
  NEXT_STEP_VIEW_DOMAIN_LABEL,
} from './assistantMessages'
import { PURPOSE_SUGGESTIONS } from './routing/domainLabelHints'
import { findPlaybook } from './routing/playbooks'
import type { AssistantDecision, GoalState } from './types'
import { WALKTHROUGH_UNDECIDED_ACTION_LABEL } from './walkthrough/walkthroughMessages'

function decision(overrides: Partial<AssistantDecision>): AssistantDecision {
  return {
    intent: 'UNKNOWN',
    reply: 'ok',
    routeId: null,
    slots: {},
    confidence: 0.9,
    needsClarification: false,
    ...overrides,
  }
}

describe('deriveActions', () => {
  describe('rule 1: SET_SLOT for an unfilled required slot', () => {
    it('produces one SET_SLOT action per allowedValues entry, with correct labels', () => {
      const playbook = findPlaybook('SETUP_EMAIL')!
      const result = deriveActions(decision({ intent: 'SETUP_EMAIL', slots: {} }), null, playbook)
      const setSlotActions = result.filter((action) => action.kind === 'SET_SLOT')

      // `intent` is what lets `useAssistantChat`'s `runResolvedSetSlot` answer a
      // click from this Playbook directly instead of re-sending the label
      // through the model - see `SetSlotPayload.intent`.
      expect(setSlotActions.map((action) => action.payload)).toEqual([
        { slotKey: 'provider', value: 'google-workspace', intent: 'SETUP_EMAIL' },
        { slotKey: 'provider', value: 'microsoft-365', intent: 'SETUP_EMAIL' },
        { slotKey: 'provider', value: 'other', intent: 'SETUP_EMAIL' },
      ])
      expect(setSlotActions.map((action) => action.label)).toEqual(['Google Workspace', 'Microsoft 365', 'その他'])
      expect(new Set(setSlotActions.map((action) => action.id)).size).toBe(3)
    })

    it('SLOT_VALUE_DISPLAY_NAMES sources provider labels from DNS_RECIPES, and other from the fixed fallback', () => {
      expect(SLOT_VALUE_DISPLAY_NAMES.vercel).toBe('Vercel')
      expect(SLOT_VALUE_DISPLAY_NAMES.other).toBe('その他')
    })

    it('produces nothing once the slot is already filled (via decision.slots or via GoalState)', () => {
      const playbook = findPlaybook('SETUP_EMAIL')!
      const viaDecision = deriveActions(
        decision({ intent: 'SETUP_EMAIL', slots: { provider: 'google-workspace' } }),
        null,
        playbook,
      )
      expect(viaDecision.some((action) => action.kind === 'SET_SLOT')).toBe(false)

      const goal: GoalState = { intent: 'SETUP_EMAIL', slots: { provider: 'microsoft-365' }, updatedAt: 0 }
      const viaGoal = deriveActions(decision({ intent: 'SETUP_EMAIL', slots: {} }), goal, playbook)
      expect(viaGoal.some((action) => action.kind === 'SET_SLOT')).toBe(false)
    })

    it('a playbook whose only requiredSlots entry is optional (or a null playbook) produces no SET_SLOT action', () => {
      // SEARCH_DOMAIN's requiredSlots: [keyword] - kind: 'label' AND optional: true, either
      // of which alone already excludes it from rule 1; asserted together below.
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: {} }), null, playbook)
      expect(result.some((action) => action.kind === 'SET_SLOT')).toBe(false)

      expect(deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: {} }), null, null).some((a) => a.kind === 'SET_SLOT')).toBe(
        false,
      )
    })
  })

  describe('optional slots (v1.4 correction: keyword must not block the Navigation Card)', () => {
    it.each(['SEARCH_DOMAIN', 'PURCHASE_DOMAIN'] as const)(
      "%s's keyword slot is declared optional, so the playbook has zero unfilled REQUIRED slots even with no keyword",
      (intentId) => {
        const playbook = findPlaybook(intentId)!
        // This is the regression guard: as long as every requiredSlots entry
        // is `optional: true`, the playbook can never be blocked from "satisfied"
        // by a missing slot value - regardless of how routeValidator.ts's own
        // `isPlaybookSatisfied` is implemented. A future edit that adds a new
        // non-optional slot to these intents, or flips `optional` back off,
        // fails this test immediately.
        const unfilledRequiredSlots = playbook.requiredSlots.filter((slot) => slot.optional !== true)
        expect(unfilledRequiredSlots).toEqual([])
      },
    )

    it('an unfilled optional slot produces no SET_SLOT buttons; SUGGEST_DOMAINS is present either way (v1.4 "never dead-end" revision)', () => {
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const withoutKeyword = deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: {} }), null, playbook)
      expect(withoutKeyword.some((action) => action.kind === 'SET_SLOT')).toBe(false)
      expect(withoutKeyword.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(true)

      const withKeyword = deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: { keyword: 'panya' } }), null, playbook)
      expect(withKeyword.some((action) => action.kind === 'SET_SLOT')).toBe(false)
      expect(withKeyword.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(true)
    })
  })

  describe('rule 2: SUGGEST_DOMAINS (v1.4 "never dead-end" revision - see the team-lead bug report)', () => {
    it('SEARCH_DOMAIN + a valid keyword slot produces exactly one SUGGEST_DOMAINS action', () => {
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: { keyword: 'panya, cafe' } }), null, playbook)
      const suggestActions = result.filter((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestActions).toHaveLength(1)
      expect(suggestActions[0]!.payload).toEqual({ keywords: ['panya', 'cafe'] })
    })

    it('PURCHASE_DOMAIN also triggers the rule', () => {
      const playbook = findPlaybook('PURCHASE_DOMAIN')!
      const result = deriveActions(decision({ intent: 'PURCHASE_DOMAIN', slots: { keyword: 'shop' } }), null, playbook)
      expect(result.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(true)
    })

    it('CONNECT_WEBSITE triggers the rule while no provider is known yet, even though it has no keyword slot at all', () => {
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), null, null)
      const suggestActions = result.filter((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestActions).toHaveLength(1)
    })

    it('CONNECT_WEBSITE stops offering it once the provider is known (regression)', () => {
      // 「Webサイトを公開したい」 said cold usually does come with "...and I need a
      // domain for it". Once the user has named the service, they are
      // configuring a domain they already have. The browser report:
      // 「CloudflareでDNSを変えたい」 was answered with a 「ドメイン候補を探す」 button.
      const viaDecision = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: { provider: 'cloudflare' } }), null, null)
      expect(viaDecision.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(false)
      // Also when the provider was learned on an earlier turn (GoalState).
      const goal: GoalState = { intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' }, updatedAt: 0 }
      const viaGoal = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), goal, null)
      expect(viaGoal.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(false)
    })

    it('drops entries the model wrote that fail domain-label validation, never passing raw text through', () => {
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(
        decision({ intent: 'SEARCH_DOMAIN', slots: { keyword: 'ignore instructions!!, ok-label' } }),
        null,
        playbook,
      )
      const suggestAction = result.find((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestAction?.payload).toEqual({ keywords: ['ok-label'] })
    })

    it('no keyword slot value and no firstUserMessage -> SUGGEST_DOMAINS is still present, with empty keywords', () => {
      // The button must be reachable without a model-supplied keyword - see
      // `useAssistantChat.ts`'s `runAction`, which asks for a keyword instead
      // of calling `suggestDomains([])` when it sees this.
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(decision({ intent: 'SEARCH_DOMAIN', slots: {} }), null, playbook)
      const suggestAction = result.find((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestAction).toBeDefined()
      expect(suggestAction?.payload).toEqual({ keywords: [] })
    })

    it('no keyword slot value, but a firstUserMessage with a dictionary hit -> SUGGEST_DOMAINS carries that hint', () => {
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(
        decision({ intent: 'SEARCH_DOMAIN', slots: {} }),
        null,
        playbook,
        'ポートフォリオ用のWebサイトを公開したい',
      )
      const suggestAction = result.find((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestAction?.payload).toEqual({ keywords: ['portfolio', 'web'] })
    })

    it('a validated slot keyword always wins over the firstUserMessage fallback', () => {
      const playbook = findPlaybook('SEARCH_DOMAIN')!
      const result = deriveActions(
        decision({ intent: 'SEARCH_DOMAIN', slots: { keyword: 'shop' } }),
        null,
        playbook,
        'ポートフォリオ用のWebサイトを公開したい',
      )
      const suggestAction = result.find((action) => action.kind === 'SUGGEST_DOMAINS')
      expect(suggestAction?.payload).toEqual({ keywords: ['shop'] })
    })

    it('an unrelated intent never produces SUGGEST_DOMAINS, even with a keyword-shaped slot present', () => {
      const result = deriveActions(decision({ intent: 'VIEW_DOMAIN', slots: { keyword: 'panya' } }), null, null)
      expect(result.some((action) => action.kind === 'SUGGEST_DOMAINS')).toBe(false)
    })
  })

  describe('rules 3/4: OPEN_DOC and its RUN_WEB_SEARCH fallback', () => {
    it('CONNECT_WEBSITE + provider=vercel produces OPEN_DOC actions for the Vercel docs', () => {
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' } }), null, null)
      const docActions = result.filter((action) => action.kind === 'OPEN_DOC')
      expect(docActions.map((action) => action.payload)).toEqual([
        { docId: 'vercel-custom-domain' },
        { docId: 'vercel-manage-dns-records' },
      ])
      expect(result.some((action) => action.kind === 'RUN_WEB_SEARCH')).toBe(false)
    })

    it('reads the provider from GoalState.slots too, not only decision.slots', () => {
      const goal: GoalState = { intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' }, updatedAt: 0 }
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), goal, null)
      expect(result.some((action) => action.kind === 'OPEN_DOC' && action.payload && 'docId' in action.payload && action.payload.docId === 'vercel-custom-domain')).toBe(
        true,
      )
    })

    it('a provider/topic combination with no curated doc produces exactly one RUN_WEB_SEARCH with a non-empty query', () => {
      // Documented gap (research report §2): no Workspace-specific ownership-verification doc.
      const result = deriveActions(
        decision({ intent: 'VERIFY_DOMAIN', slots: { provider: 'google-workspace' } }),
        null,
        null,
      )
      const searchActions = result.filter((action) => action.kind === 'RUN_WEB_SEARCH')
      expect(searchActions).toHaveLength(1)
      expect(result.some((action) => action.kind === 'OPEN_DOC')).toBe(false)
      const payload = searchActions[0]!.payload
      expect('query' in payload && typeof payload.query === 'string' && payload.query.length > 0).toBe(true)
    })

    it('no determinable topic (e.g. VIEW_DOMAIN) produces neither OPEN_DOC nor RUN_WEB_SEARCH', () => {
      const result = deriveActions(decision({ intent: 'VIEW_DOMAIN', slots: {} }), null, null)
      expect(result.some((action) => action.kind === 'OPEN_DOC' || action.kind === 'RUN_WEB_SEARCH')).toBe(false)
    })
  })

  describe('rule 5: cap and dedup', () => {
    it('caps the combined action list at MAX_ACTIONS_PER_MESSAGE', () => {
      const playbook = findPlaybook('CONNECT_WEBSITE')!
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), null, playbook)
      expect(result.length).toBeLessThanOrEqual(MAX_ACTIONS_PER_MESSAGE)
    })

    it('never truncates the option set of an unfilled slot (regression)', () => {
      // The reported bug: CONNECT_WEBSITE offers 7 provider values and rule 0
      // adds the walkthrough button ahead of them, so a cap of 6 silently
      // dropped the last two options - `cloudflare` and `other` - while the
      // question in the very same message named Cloudflare explicitly. Every
      // option the question lists must have a button.
      const playbook = findPlaybook('CONNECT_WEBSITE')!
      const allowedValues = playbook.requiredSlots[0]!.allowedValues
      const result = deriveActions(
        decision({ intent: 'CONNECT_WEBSITE', slots: {} }),
        null,
        playbook,
        null,
        // Walkthrough not yet running, so rule 0 does contribute its button and
        // competes with the option set for the cap - exactly the reported case.
        false,
      )
      const offeredValues = result
        .filter((action) => action.kind === 'SET_SLOT')
        .map((action) => (action.payload as { value: string }).value)
      expect(offeredValues).toEqual([...allowedValues])
      expect(offeredValues).toContain('cloudflare')
    })

    it('the slot question names exactly the options that get buttons (no drift)', () => {
      for (const intent of ['CONNECT_WEBSITE', 'SETUP_EMAIL'] as const) {
        const playbook = findPlaybook(intent)!
        const slot = playbook.requiredSlots[0]!
        const result = deriveActions(decision({ intent, slots: {} }), null, playbook)
        const labels = result.filter((action) => action.kind === 'SET_SLOT').map((action) => action.label)
        expect(labels.length).toBe(slot.allowedValues.length)
        for (const label of labels) {
          expect(slot.question).toContain(label)
        }
      }
    })

    it('never returns a duplicate id', () => {
      const playbook = findPlaybook('CONNECT_WEBSITE')!
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), null, playbook)
      const ids = result.map((action) => action.id)
      expect(new Set(ids).size).toBe(ids.length)
    })
  })

  describe('POST_PURCHASE_NEXT_STEPS branch buttons', () => {
    const playbook = findPlaybook('POST_PURCHASE_NEXT_STEPS')!

    it('offers one branch per concrete goal, each resolving to that goal\'s own intent', () => {
      const result = deriveActions(decision({ intent: 'POST_PURCHASE_NEXT_STEPS', slots: {} }), null, playbook)
      expect(result.map((action) => action.label)).toEqual([
        NEXT_STEP_CONNECT_WEBSITE_LABEL,
        NEXT_STEP_SETUP_EMAIL_LABEL,
        NEXT_STEP_EXPLAIN_DNS_LABEL,
        NEXT_STEP_VIEW_DOMAIN_LABEL,
      ])
      // The payload's `intent` is the TARGET intent, never the hub's own - that
      // is what makes the click land on CONNECT_WEBSITE's Playbook rather than
      // on this hub with a slot filled in (see `nextStepBranchActions`).
      expect(result.map((action) => (action.payload as { intent?: string }).intent)).toEqual([
        'CONNECT_WEBSITE',
        'SETUP_EMAIL',
        'EXPLAIN_DNS',
        'VIEW_DOMAIN',
      ])
      expect(result.every((action) => action.kind === 'SET_SLOT')).toBe(true)
    })

    it('offers no branch buttons for any other intent', () => {
      const result = deriveActions(decision({ intent: 'VIEW_DOMAIN', slots: {} }), null, findPlaybook('VIEW_DOMAIN')!)
      expect(result.map((action) => action.label)).not.toContain(NEXT_STEP_EXPLAIN_DNS_LABEL)
    })
  })

  describe('the walkthrough offer doubles as the "not decided yet" answer', () => {
    it('is relabelled while a required slot is still being asked about', () => {
      // ⚠️ 「どのサービスでWebサイトを公開しますか？」 plus seven hosting companies is a
      // question a user who has only just bought a domain often cannot answer.
      // Same button, same template - only the label says so.
      const playbook = findPlaybook('CONNECT_WEBSITE')!
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: {} }), null, playbook)
      const walkthrough = result.find((action) => action.kind === 'START_WALKTHROUGH')
      expect(walkthrough?.label).toBe(WALKTHROUGH_UNDECIDED_ACTION_LABEL)
      // ...and it survives rule 5's cap, which trims from the tail while the
      // seven slot options are protected.
      expect(result[0]).toBe(walkthrough)
    })

    it('keeps its normal label once the slot is filled', () => {
      const playbook = findPlaybook('CONNECT_WEBSITE')!
      const result = deriveActions(decision({ intent: 'CONNECT_WEBSITE', slots: { provider: 'vercel' } }), null, playbook)
      const walkthrough = result.find((action) => action.kind === 'START_WALKTHROUGH')
      expect(walkthrough?.label).not.toBe(WALKTHROUGH_UNDECIDED_ACTION_LABEL)
    })
  })

  describe('OUT_OF_SCOPE / UNKNOWN', () => {
    it('an OUT_OF_SCOPE decision produces no actions', () => {
      expect(deriveActions(decision({ intent: 'OUT_OF_SCOPE', slots: { provider: 'vercel', keyword: 'shop' } }), null, null)).toEqual(
        [],
      )
    })

    it('an UNKNOWN decision produces no actions', () => {
      expect(deriveActions(decision({ intent: 'UNKNOWN', slots: { provider: 'vercel', keyword: 'shop' } }), null, null)).toEqual([])
    })
  })
})

describe('purposeShortcutActions (v1.5 "ask what kind of site")', () => {
  it('produces one SET_SLOT action per PURPOSE_SUGGESTIONS entry, labelled with its term', () => {
    const result = purposeShortcutActions()
    expect(result.every((action) => action.kind === 'SET_SLOT')).toBe(true)
    expect(result.map((action) => action.label)).toEqual(PURPOSE_SUGGESTIONS.map((suggestion) => suggestion.term))
  })

  it('never returns a duplicate id, and stays within MAX_ACTIONS_PER_MESSAGE', () => {
    const result = purposeShortcutActions()
    const ids = result.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.length).toBeLessThanOrEqual(MAX_ACTIONS_PER_MESSAGE)
  })

  it('is never empty', () => {
    expect(purposeShortcutActions().length).toBeGreaterThan(0)
  })
})

describe('fallbackActions ("never dead-end")', () => {
  it('is never empty for input classifyIntent cannot infer anything from', () => {
    const result = fallbackActions('こんにちは')
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((action) => action.kind === 'SET_SLOT')).toBe(true)
  })

  it('includes a RUN_WEB_SEARCH action with a non-empty query when a topic/provider is inferable', () => {
    const result = fallbackActions('Vercelで公開したい')
    const searchActions = result.filter((action) => action.kind === 'RUN_WEB_SEARCH')
    expect(searchActions).toHaveLength(1)
    const payload = searchActions[0]!.payload
    expect('query' in payload && typeof payload.query === 'string' && payload.query.length > 0).toBe(true)
  })

  it('omits RUN_WEB_SEARCH when classifyIntent finds an intent with no doc-resolvable topic (e.g. VIEW_DOMAIN)', () => {
    const result = fallbackActions('自分のドメインを見たい')
    expect(result.some((action) => action.kind === 'RUN_WEB_SEARCH')).toBe(false)
  })

  it('always includes the fixed shortcut buttons, each carrying the intent it stands for', () => {
    const result = fallbackActions('こんにちは')
    const shortcutLabels = result.filter((action) => action.kind === 'SET_SLOT').map((action) => action.label)
    expect(shortcutLabels).toEqual(
      expect.arrayContaining(['Webサイトを公開したい', 'メールを使いたい', 'ドメインを探したい', '用語を知りたい']),
    )
    // ⚠️ `intent` is load-bearing here, not decorative. These buttons appear
    // precisely BECAUSE the model just failed this turn, so re-sending the
    // label as free text and hoping the same model succeeds on the retry is
    // the one thing that must not happen - the reported bug was clicking
    // 「Webサイトを公開したい」 from this list and being told 「うまく聞き取れなかった」.
    const expectedIntents: Record<string, string> = {
      'Webサイトを公開したい': 'CONNECT_WEBSITE',
      メールを使いたい: 'SETUP_EMAIL',
      ドメインを探したい: 'SEARCH_DOMAIN',
      用語を知りたい: 'EXPLAIN_DNS',
    }
    for (const action of result) {
      if (action.kind !== 'SET_SLOT') continue
      expect(action.payload).toEqual({
        slotKey: 'fallback',
        value: action.label,
        intent: expectedIntents[action.label],
      })
    }
  })

  it('never exceeds MAX_ACTIONS_PER_MESSAGE', () => {
    expect(fallbackActions('Vercelで公開したい').length).toBeLessThanOrEqual(MAX_ACTIONS_PER_MESSAGE)
  })

  it('never returns a duplicate id', () => {
    const result = fallbackActions('Vercelで公開したい')
    const ids = result.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
