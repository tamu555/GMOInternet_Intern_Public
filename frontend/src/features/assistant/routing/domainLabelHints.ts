/**
 * Deterministic Japanese-text -> domain-label hints. `docs/project-overview.html`
 * assigns exactly this job to the AI ("自由文の解釈、日本語→ドメイン文字列変換" -
 * the two places AI genuinely adds value over a pure rule engine), but a
 * 0.6B model almost never produces a usable ASCII label from Japanese input,
 * and the "never dead-end" fallback (`useAssistantChat.ts`'s `applyFallback`,
 * `actions.ts`'s `SUGGEST_DOMAINS` wiring) runs with no model output to lean
 * on at all. This module is the rule-based half of that job.
 *
 * ⚠️ Deliberately NOT a kana->romaji transliterator. Mechanical romanisation
 * of arbitrary Japanese ("パン屋" -> "panya", "美容室" -> "biyoushitsu") produces
 * labels a native speaker would find odd or embarrassing on a real registrar
 * UI, and there is no way to guess which romanisation scheme (Hepburn,
 * Kunrei, a business's own preferred spelling) the user actually wants. A
 * small curated dictionary of common purposes, plus honestly asking the user
 * when nothing matches (see `useAssistantChat.ts`'s `applyFallback` / the
 * Playbook's `keyword` slot question), is predictable and never embarrassing
 * - guessing wrong silently is worse than asking.
 */
import { normalizeDomainLabel, validateDomainLabel } from '../../domains/validation'

/**
 * Small, obvious, common-purpose nouns a beginner is likely to type when
 * describing what a domain/site is for. Intentionally short - this is a
 * convenience shortcut for the SUGGEST_DOMAINS button, not a translator (see
 * the module doc). Add an entry only when the English word is the single
 * unambiguous, unembarrassing choice.
 *
 * `term` is the single canonical Japanese word for this entry - the exact
 * text `PURPOSE_SUGGESTIONS` below shows on its shortcut button, and always a
 * string `pattern` itself matches (asserted in `domainLabelHints.test.ts`).
 * For an alternation (`パン屋|ベーカリー`) it is the first, most beginner-obvious
 * alternative - only for building `PURPOSE_SUGGESTIONS`, never used by
 * `labelHintsFromText` itself.
 */
const NOUN_DICTIONARY: readonly { pattern: RegExp; label: string; term: string }[] = [
  { pattern: /ポートフォリオ/, label: 'portfolio', term: 'ポートフォリオ' },
  { pattern: /パン屋|ベーカリー/, label: 'bakery', term: 'パン屋' },
  { pattern: /カフェ/, label: 'cafe', term: 'カフェ' },
  { pattern: /ブログ/, label: 'blog', term: 'ブログ' },
  { pattern: /会社|企業/, label: 'company', term: '会社' },
  { pattern: /お店|ショップ/, label: 'shop', term: 'お店' },
  { pattern: /写真/, label: 'photo', term: '写真' },
  { pattern: /教室/, label: 'school', term: '教室' },
  { pattern: /病院|クリニック/, label: 'clinic', term: '病院' },
  { pattern: /美容室/, label: 'salon', term: '美容室' },
  { pattern: /名刺/, label: 'card', term: '名刺' },
  { pattern: /日記/, label: 'diary', term: '日記' },
  { pattern: /作品/, label: 'works', term: '作品' },
]

/**
 * A handful of the most beginner-recognisable purposes from `NOUN_DICTIONARY`
 * above - shown as shortcut buttons on `SUGGEST_DOMAINS_ASK_PURPOSE_MESSAGE`
 * (`actions.ts`'s `purposeShortcutActions`, `useAssistantChat.ts`'s
 * `runAction`) so a beginner can answer "what kind of site" with one click.
 * Derived from `NOUN_DICTIONARY` (never a hand-duplicated `term`/`label`
 * pair) via `SHOWN_PURPOSE_LABELS`, which only fixes the button ORDER to
 * match the question's own worked examples - the `term`/`label` values
 * themselves always come straight from the one dictionary entry.
 */
const SHOWN_PURPOSE_LABELS: readonly string[] = ['portfolio', 'blog', 'shop', 'company', 'photo']

export const PURPOSE_SUGGESTIONS: readonly { term: string; label: string }[] = SHOWN_PURPOSE_LABELS.map((label) => {
  const entry = NOUN_DICTIONARY.find((candidate) => candidate.label === label)
  if (!entry) throw new Error(`domainLabelHints: no NOUN_DICTIONARY entry for label "${label}"`)
  return { term: entry.term, label: entry.label }
})

/** Any run of ASCII letters/digits/hyphens starting with a letter - "myshop" in "myshopというサイトを作りたい" should be picked up as-is. */
const ASCII_WORD_PATTERN = /[A-Za-z][A-Za-z0-9-]*/g

/** Mirrors `routing/playbooks.ts`'s `validateLabelSlotValue` cap on a single `keyword` slot's entries. */
const MAX_HINTS = 5

/**
 * Normalizes and validates `candidate` through the EXACT same validators the
 * domain-search page's own form uses (never a new regex - see the module
 * doc's "reuse, not reimplement" precedent from `routing/playbooks.ts`).
 * Lower-cased first since DNS labels are case-insensitive and the dictionary
 * above is already lower-case - an ASCII word typed in mixed/upper case
 * (`"MyShop"`) should still produce one consistent hint, not a near-duplicate.
 */
function toValidatedLabel(candidate: string): string | null {
  const normalized = normalizeDomainLabel(candidate.toLowerCase())
  if (normalized === '') return null
  if (validateDomainLabel(normalized) !== undefined) return null
  return normalized
}

/**
 * Deterministic hints for the `SUGGEST_DOMAINS` Quick Action's `keywords`
 * (design contract §4.1) when the model produced no usable `keyword` slot
 * value - see `useAssistantChat.ts`'s `applyFallback` and `actions.ts`.
 * Order: curated dictionary hits first, then any ASCII word already present
 * in `normalizedInput`, deduplicated, capped at `MAX_HINTS`. Returns `[]`
 * when nothing matches - the caller then asks the user directly rather than
 * guessing (see the module doc).
 */
export function labelHintsFromText(normalizedInput: string): string[] {
  const seen = new Set<string>()
  const hints: string[] = []

  function add(candidate: string): void {
    if (hints.length >= MAX_HINTS) return
    const label = toValidatedLabel(candidate)
    if (label === null || seen.has(label)) return
    seen.add(label)
    hints.push(label)
  }

  for (const entry of NOUN_DICTIONARY) {
    if (hints.length >= MAX_HINTS) break
    if (entry.pattern.test(normalizedInput)) add(entry.label)
  }

  const asciiWords = normalizedInput.match(ASCII_WORD_PATTERN) ?? []
  for (const word of asciiWords) {
    if (hints.length >= MAX_HINTS) break
    add(word)
  }

  return hints
}
