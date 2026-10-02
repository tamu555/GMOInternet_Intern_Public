/**
 * Looks up curated doc sources (§5.1) and builds the search-query fallback
 * (§5.2, design contract §5) when nothing curated covers the topic.
 */
import { DNS_RECIPES } from '../../dns/recipes'
import { providerNeedsNameserverChange } from '../routing/playbooks'
import type { IntentId } from '../routing/playbooks'
import { ASSISTANT_DOC_SOURCES, type AssistantDocSource, type DocTopic } from './docSources'

export interface DocLookup {
  providerId?: string | null
  topic?: DocTopic | null
  /** e.g. 'TXT' - narrows glossary lookups, see resolveDocSources. */
  recordType?: string | null
}

const DEFAULT_RESULT_LIMIT = 3

/** §10.2: which DocTopic (if any) an IntentId implies. */
const INTENT_TOPICS: Partial<Record<IntentId, DocTopic>> = {
  CONNECT_WEBSITE: 'custom-domain',
  CHANGE_NAMESERVER: 'nameserver',
  SETUP_EMAIL: 'email',
  VERIFY_DOMAIN: 'verification',
  EXPLAIN_DNS: 'glossary',
  EXPLAIN_RECORD: 'glossary',
}

export function topicForIntent(intent: IntentId): DocTopic | null {
  return INTENT_TOPICS[intent] ?? null
}

/**
 * The topic to actually look documentation up under, once the `provider` slot
 * is known.
 *
 * `INTENT_TOPICS` maps `CONNECT_WEBSITE -> 'custom-domain'`, which is right for
 * every provider that is connected by writing records here - but wrong for a
 * `mode: 'ns-guide'` provider (Cloudflare, エックスサーバー), which is connected by
 * changing the nameservers instead. `resolveRouteForSlots` already sends those
 * two to `DNS_NAMESERVER` for exactly this reason; the doc lookup has to follow
 * the same branch or it asks for a topic the provider has no page under. That
 * was measurable: `{providerId: 'cloudflare', topic: 'custom-domain'}` matched
 * zero rows even though the registry does carry a Cloudflare page - filed
 * under `nameserver`, the topic that actually describes the work.
 */
export function topicForIntentAndProvider(intent: IntentId, providerId: string | null): DocTopic | null {
  return topicForProvider(topicForIntent(intent), providerId)
}

/**
 * The same branch as `topicForIntentAndProvider`, keyed on the TOPIC instead of
 * on an `IntentId` - for callers that already hold a topic and never had an
 * intent.
 *
 * `AssistantModal`'s `handleRunStepAction` is that caller: a walkthrough step
 * carries a compile-time `docTopic` (`walkthroughTemplates.ts`), not an intent,
 * so it could not reuse the intent-keyed function and was silently doing no
 * branching at all. Expressed here once and delegated to from above rather than
 * copied into the modal (§14.2 「二重定義を作らない」) - the two call sites must
 * not be able to disagree about which topic an `ns-guide` provider is
 * documented under.
 *
 * Keying on `'custom-domain'` rather than on `CONNECT_WEBSITE` is equivalent
 * today (`INTENT_TOPICS` maps exactly one intent to that topic) and is the more
 * general statement of the rule: it is the TOPIC "how do I point my domain at
 * this service" that an `ns-guide` provider answers under `nameserver`,
 * whichever intent asked.
 */
export function topicForProvider(topic: DocTopic | null, providerId: string | null): DocTopic | null {
  if (topic === 'custom-domain' && providerNeedsNameserverChange(providerId)) return 'nameserver'
  return topic
}

/** `glossary-<type>-record`, matching this registry's glossary id convention (e.g. 'TXT' -> 'glossary-txt-record'). */
function glossaryIdForRecordType(recordType: string): string {
  return `glossary-${recordType.toLowerCase()}-record`
}

/**
 * Matches on `providerId` and `topic`.
 *
 * ⚠️ An absent/`null` `providerId` means **provider-agnostic sources only** -
 * it is NOT "any provider". The earlier reading (skip the provider filter
 * entirely when none was given) produced a real, user-reported wrong answer:
 * a `CONNECT_WEBSITE` turn whose `provider` slot was not filled asked for
 * `{providerId: null, topic: 'custom-domain'}`, matched every vendor's
 * custom-domain page at once, and - because the ranking below puts `ja` ahead
 * of `en` - surfaced さくらのレンタルサーバ and エックスサーバー links to a user who
 * had been talking about Cloudflare. Recommending one hosting company's manual
 * to someone using another is worse than recommending nothing: with no
 * provider-agnostic entry for the topic this now returns `[]`, and
 * `actions.ts` falls through to the neutral `buildSearchQuery` card instead.
 *
 * `topic: 'glossary'` with no provider still returns the glossary entries
 * (they are exactly the `providerId === null` rows), optionally narrowed by
 * `recordType` to the single entry for that record type - falling back to the
 * full glossary set if no entry matches, rather than returning nothing.
 *
 * Within the matched set, ja-language sources rank before en; ties keep
 * registry order (`Array.prototype.sort` is stable).
 */
export function resolveDocSources(lookup: DocLookup, limit: number = DEFAULT_RESULT_LIMIT): AssistantDocSource[] {
  const wantedProviderId = lookup.providerId ?? null

  let candidates = ASSISTANT_DOC_SOURCES.filter((source) => {
    if (source.providerId !== wantedProviderId) return false
    if (lookup.topic != null && source.topic !== lookup.topic) return false
    return true
  })

  if (wantedProviderId === null && lookup.topic === 'glossary' && lookup.recordType) {
    const narrowed = candidates.filter((source) => source.id === glossaryIdForRecordType(lookup.recordType!))
    if (narrowed.length > 0) candidates = narrowed
  }

  const ranked = [...candidates].sort((a, b) => {
    if (a.language === b.language) return 0
    return a.language === 'ja' ? -1 : 1
  })

  return ranked.slice(0, limit)
}

/**
 * Fixed, beginner-friendly search phrase per topic (§5.2: "allowlisted
 * vocabulary only"). Never derived from user text.
 */
const TOPIC_SEARCH_PHRASES: Record<DocTopic, string> = {
  'custom-domain': 'カスタムドメイン 設定方法',
  nameserver: 'ネームサーバー 変更方法',
  verification: 'ドメイン 所有権確認 TXTレコード',
  email: 'メール DNSレコード 設定',
  glossary: 'DNS 用語 解説',
}

/** The only record-type tokens `buildSearchQuery` will ever emit (mirrors `DnsRecordType`). */
const KNOWN_RECORD_TYPES: readonly string[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']

/**
 * Composes a search-engine query from an ALLOWLISTED VOCABULARY ONLY:
 * provider display names sourced from `DNS_RECIPES` (`recipe.service`), the
 * fixed `TOPIC_SEARCH_PHRASES` above, and a record-type token that must be
 * one of `KNOWN_RECORD_TYPES`. `DocLookup`'s own type shape makes this safe
 * by construction - its fields are enum-ish identifiers the app already
 * validated (a Playbook slot value, an `IntentId`-derived topic, a
 * `DnsRecordType`), never a `string` holding arbitrary user input. Free
 * text the user typed into chat MUST NEVER be threaded into this function
 * (directly or via a new field) - doing so would turn the "検索する" button
 * into a channel that exfiltrates whatever the user typed to a third-party
 * search engine's server logs, which is exactly what §17.3/D1 rule out.
 *
 * Returns `null` when there is nothing meaningful to search for (all three
 * inputs absent/unrecognised).
 */
export function buildSearchQuery(lookup: DocLookup): string | null {
  const parts: string[] = []

  if (lookup.providerId) {
    const recipe = DNS_RECIPES.find((candidate) => candidate.id === lookup.providerId)
    if (recipe) parts.push(recipe.service)
  }

  if (lookup.recordType && KNOWN_RECORD_TYPES.includes(lookup.recordType)) {
    parts.push(`${lookup.recordType}レコード`)
  }

  if (lookup.topic) {
    parts.push(TOPIC_SEARCH_PHRASES[lookup.topic])
  }

  if (parts.length === 0) return null
  return parts.join(' ')
}

/**
 * 🤔 Product decision recorded in the spec's §27.2: default search engine is
 * Google. Exported so the UI can name the destination host before the user
 * clicks (same transparency `DocSourceCard` gives for curated links).
 */
export const SEARCH_ENGINE_NAME = 'Google'

export function searchUrlForQuery(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}
