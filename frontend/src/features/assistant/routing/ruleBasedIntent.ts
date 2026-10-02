/**
 * Deterministic, offline, rule-based intent classifier - the fallback path
 * `useAssistantChat.ts`'s `applyFallback` uses whenever the LLM's own output
 * could not be parsed or passed `guardDecision` (spec browser-ai.md §11.5).
 *
 * This is exactly the abstraction `docs/project-overview.html`'s decision log
 * calls for: 「候補提案のコアはルールベース、AIは限定適用」 and 「デモはルールベースの
 * フォールバックで確実に動かす」, with an `IntentParser` that is "ルールベース／Claude"
 * - i.e. AI augments a rule-based core, and the rule-based path alone must be
 * enough to demo the product end to end. `classifyIntent` below is that
 * rule-based `IntentParser`: pure, synchronous, has no React/DOM/network
 * dependency, and never calls the LLM.
 *
 * Deliberately narrower than the LLM: it only recognises a fixed set of
 * common phrasings (see `INTENT_MATCHERS` below) and produces no `reply` text
 * of its own - the caller combines a `RuleBasedGuess` with the matched
 * Playbook (`routing/playbooks.ts`) to build a reply, exactly mirroring how a
 * validated LLM decision is turned into one.
 *
 * The pattern set is validated against `e2e/assistant-eval/dataset.json`'s
 * 300 `category: "in_scope"` cases and 50 `category: "out_of_scope"` cases
 * (`ruleBasedIntent.test.ts`'s "dataset coverage" suite) - every regex below
 * was chosen or excluded because of a specific case in that corpus; see the
 * per-matcher comments for the concrete collisions each ordering/exclusion
 * resolves.
 */
import { DNS_RECIPES } from '../../dns/recipes'
import type { IntentId } from './playbooks'

/** One rule-based classification: an `IntentId` plus any Playbook slot values inferred from the text. */
export interface RuleBasedGuess {
  intent: IntentId
  /** Only ever a Playbook `requiredSlots` key (e.g. `provider`) - never raw user text passed through unvalidated. */
  slots: Record<string, string>
  /** The literal keyword(s)/phrase(s) that made this rule fire - diagnostics/test-readability only, not used for routing. */
  matchedTerms: string[]
}

function guess(intent: IntentId, slots: Record<string, string>, matchedTerms: string[]): RuleBasedGuess {
  return { intent, slots, matchedTerms }
}

/** Returns the first pattern's match text, or `null` if none of `patterns` matched `input`. */
function firstMatch(input: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(input)
    if (match) return match[0]
  }
  return null
}

/** Escapes `term` for safe use inside a `new RegExp(...)` constructed at runtime (see `isEffectivelyBareMention`). */
function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `input`, once the already-matched `term` (e.g. a provider name)
 * is removed, has almost nothing left - i.e. the whole message *was*
 * essentially just that one word (dataset examples: bare `"vercel"`,
 * `"microsoft 365"`, `"さくら"`). This is deliberately narrow: a provider name
 * mentioned inside a longer sentence with no accompanying verb (e.g.
 * 「エックスサーバーの料金プランを教えてください」, an `out_of_scope` dataset case
 * asking about pricing, not wanting to use the service) must NOT fire an
 * intent just because the brand name appears - see the team-lead's explicit
 * "do not fuzzy-match brand names into false positives" instruction. Only a
 * genuinely bare mention gets this leniency; every other case still requires
 * a real verb/context match from the matcher that calls this.
 */
function isEffectivelyBareMention(input: string, term: string): boolean {
  const withoutTerm = input.replace(new RegExp(escapeForRegExp(term), 'i'), '').trim()
  return withoutTerm.length <= 2
}

/**
 * Provider aliases, keyed by `DNS_RECIPES` id (never hand-duplicated - see
 * the module doc) - covers the exact Japanese/English/katakana spellings a
 * beginner is likely to type, including product names that imply the
 * provider without naming it (`Gmail`/`Outlook` for the two mail providers).
 * `recipe.category` ('web' vs 'mail') is what separates `CONNECT_WEBSITE`'s
 * allowed providers from `SETUP_EMAIL`'s, mirroring `routing/playbooks.ts`'s
 * two `provider` slots exactly.
 */
const PROVIDER_ALIAS_PATTERNS: Readonly<Record<string, RegExp>> = {
  vercel: /vercel|バーセル|ヴァーセル/i,
  netlify: /netlify|ネトリファイ|ねっとりふぁい/i,
  'github-pages': /github ?pages|ギットハブページズ|githubページズ/i,
  'google-workspace': /google ?workspace|グーグル ?ワークスペース|gmail/i,
  'microsoft-365': /microsoft ?365|マイクロソフト ?365|office ?365|outlook|\bm365\b/i,
  'sakura-rental': /さくら/,
  xserver: /xserver|エックスサーバー/i,
  cloudflare: /cloudflare|クラウドフレア|くらうどふれあ/i,
}

interface ProviderMatch {
  id: string
  term: string
}

/** First `DNS_RECIPES` entry of `category` whose alias pattern matches `input`, with the literal text that matched. */
function detectProviderMatch(input: string, category: 'web' | 'mail'): ProviderMatch | null {
  for (const recipe of DNS_RECIPES) {
    if (recipe.category !== category) continue
    const pattern = PROVIDER_ALIAS_PATTERNS[recipe.id]
    const match = pattern?.exec(input)
    if (match) return { id: recipe.id, term: match[0] }
  }
  return null
}

type Matcher = (input: string) => RuleBasedGuess | null

/**
 * Reused by both the record dispatcher and `CHANGE_NAMESERVER` to tell a
 * genuine "what does X mean" question apart from an action request that
 * merely happens to contain the character 何 as part of "どこ"/"何を入れれば"
 * (dataset: 「TXTレコードって何を入れればいいの？場所だけ教えて」 is `ADD_TXT`, not
 * `EXPLAIN_RECORD`). `MARKER` alone is intentionally broader than the
 * genuine explain phrasing needs (「とは」「の意味」「の役割」「の違いは」「って何」「は何」);
 * `EXCLUSION` pulls back the ones that are actually asking where/how to
 * configure something.
 */
const EXPLAIN_QUESTION_MARKER = /とは|どういう意味|の意味|の役割|の違いは|って何|は何/
const EXPLAIN_QUESTION_EXCLUSION = /場所|どこ|追加する|入れれば|入力/

function looksLikeExplainQuestion(input: string): boolean {
  return EXPLAIN_QUESTION_MARKER.test(input) && !EXPLAIN_QUESTION_EXCLUSION.test(input)
}

/**
 * Strong, largely unambiguous troubleshooting vocabulary (反映 "propagated",
 * つながらない/表示されない "not reachable/showing", etc). Checked FIRST, before
 * every other matcher: dataset cases routinely combine this vocabulary with a
 * record type, a provider, or ネームサーバー+変更 in the same sentence (e.g.
 * 「ネームサーバーを変更したのに反映されないんですけど...」, 「TXTレコードを追加したのに認証が
 * 通らないんですけど...」) and are `TROUBLESHOOT_DNS`, not the record/nameserver
 * intent those other words would otherwise suggest - "it's already
 * configured but broken" always outranks "I want to configure it".
 */
function matchTroubleshootDns(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [
    /反映/,
    /つながらない|繋がらない/,
    /表示されない/,
    /認証が通らない/,
    /正常ですか/,
    /届かない/,
    /DNSチェック/i,
    /設定を確認したい/,
  ])
  if (!marker) return null
  return guess('TROUBLESHOOT_DNS', {}, [marker])
}

/**
 * A record-type mention (explicit name, abbreviation, or the dataset's
 * phonetic かな spellings) resolves either to `EXPLAIN_RECORD` (a genuine
 * "what is this" question, `looksLikeExplainQuestion`) or the matching
 * `ADD_*` intent. `AAAA` is checked before `A` because `"AAAAレコード"`
 * literally contains the substring `"Aレコード"` (the last `A` before
 * `レコード`) - checking A first would misclassify every AAAA-record case.
 * `NS` has no `ADD_NS_RECORD` intent (playbooks.ts has none) - a bare `NS`
 * mention with no explain marker returns `null` here so `CHANGE_NAMESERVER`
 * gets a chance instead (see its own comment).
 *
 * Checked before `SETUP_EMAIL`/`CONNECT_WEBSITE` on purpose: several `ADD_MX`/
 * `ADD_TXT` dataset cases explicitly say "MXレコード"/"TXTレコード" while ALSO
 * containing 「メール」+ a `SETUP_EMAIL` verb (e.g. 「メールを受け取れるように
 * MXレコードを設定したい」) - the explicit record name is the more specific
 * signal and must win.
 */
const RECORD_SIGNALS: readonly { intent: IntentId | null; patterns: RegExp[] }[] = [
  { intent: 'ADD_AAAA_RECORD', patterns: [/AAAAレコード/i, /クアッドエー/, /IPv6/i] },
  { intent: 'ADD_A_RECORD', patterns: [/Aレコード/i, /エーレコード/, /IPv4/i, /IPアドレス/i, /\bIP\b/i] },
  { intent: 'ADD_CNAME', patterns: [/CNAMEレコード/i, /\bCNAME\b/i, /しーねーむ/, /別名/, /エイリアス/] },
  { intent: 'ADD_MX', patterns: [/MXレコード/i, /\bMX\b/i, /えむえっくす/] },
  {
    intent: 'ADD_TXT',
    patterns: [/TXTレコード/i, /\bTXT\b/i, /てぃーえっくすてぃー/, /SPFレコード/i, /テキストレコード/],
  },
  // ⚠️ `NSレコード` is a literal substring of `DNSレコード` (D + NS + レコード),
  // so an unanchored pattern claims every generic 「DNSレコード」 mention as an
  // explicit NS-record mention. The `null` intent made that look harmless (it
  // returns `null` and lets `matchChangeNameserver` try) but it was not:
  // 「DNSレコードとは何ですか」 hit the `looksLikeExplainQuestion` branch ABOVE the
  // `null` check and answered as `EXPLAIN_RECORD` — the meaning of "the NS
  // record" — instead of `EXPLAIN_DNS`. The lookbehind requires NS to start the
  // token, which is exactly what distinguishes the real record type from the
  // tail of a longer acronym. Same substring family as the `AAAA`/`A` ordering
  // trap documented above.
  { intent: null, patterns: [/(?<![A-Za-z])NSレコード/i, /えぬえす/] },
]

function matchRecordIntent(input: string): RuleBasedGuess | null {
  for (const signal of RECORD_SIGNALS) {
    const term = firstMatch(input, signal.patterns)
    if (!term) continue
    if (looksLikeExplainQuestion(input)) return guess('EXPLAIN_RECORD', {}, [term])
    if (signal.intent === null) return null // NS with no explain marker: leave it for matchChangeNameserver.
    return guess(signal.intent, {}, [term])
  }
  return null
}

// `にしたい|にする` covers the 「メールをGoogle Workspaceにしたい」 phrasing (spec
// browser-ai.md §21.3's own canonical example) - "make X [into/via] Y", a
// different construction from 「Xを使いたい」 that shares no verb stem with it.
// `作成` is listed alongside `作りたい` for the same reason `PUBLISH_VERB_PATTERN`
// carries it: 「作りたい」 and 「作成したい」 are the same request, and only the
// former was recognised (see that pattern's own comment).
const EMAIL_VERB_PATTERN = /使[いえっう]|設定|受信|送信|送受信|受け取り|作りたい|作成|にしたい|にする/

/**
 * Gate is 「メール」/「mail」 OR a recognised mail provider - dataset cases like
 * 「microsoft365使ってます」 name only the provider, with no 「メール」 word at all,
 * while 「ProtonMailを独自ドメインで使いたいです」 names only the (English) product,
 * with no katakana 「メール」. A provider name with (almost) nothing else
 * (`isEffectivelyBareMention`) fires on its own, same as `CONNECT_WEBSITE`'s
 * bare-provider case below - see that function's comment for why this is
 * safe against false positives.
 */
function matchSetupEmail(input: string): RuleBasedGuess | null {
  const providerMatch = detectProviderMatch(input, 'mail')
  const hasEmailWord = /メール|mail/i.test(input)
  const verb = firstMatch(input, [EMAIL_VERB_PATTERN])

  if ((hasEmailWord || providerMatch) && verb) {
    const slots: Record<string, string> = {}
    const matchedTerms = [verb]
    if (providerMatch) {
      slots.provider = providerMatch.id
      matchedTerms.push(providerMatch.term)
    }
    return guess('SETUP_EMAIL', slots, matchedTerms)
  }

  if (providerMatch && isEffectivelyBareMention(input, providerMatch.term)) {
    return guess('SETUP_EMAIL', { provider: providerMatch.id }, [providerMatch.term])
  }

  return null
}

const SITE_NOUN_PATTERN = /サイト|ホームページ|ポートフォリオ/
// Stems, not just one dictionary form, since a beginner types whatever
// conjugation comes naturally: `つな[ぐぎげ]` covers 「つなぐ」/「つなぎたい」/
// 「つなげる」; `使[いえっう]` covers 「使いたい」/「使えるように」/「使ってる/使ってます」/
// 「使う」; `作[りっ]` covers 「作りたい」/「作った」. Deliberately excludes a bare
// 「設定」 - see `matchConnectWebsite`'s `providerConfigVerb` for why that has to
// be gated on a recognised provider rather than joining this shared list
// (VIEW_DOMAIN/VERIFY_DOMAIN/CREATE_SUBDOMAIN all use "ドメインの...を設定したい"
// shaped sentences too, with no provider named).
// `にしたい|にする` - same "make X [into] Y" construction as `EMAIL_VERB_PATTERN`'s
// own copy of this alternative (e.g. 「独自ドメインにしたいです」).
//
// ⚠️ `作成|制作|開設|デプロイ|リリース` were added after a real browser report:
// 「Webサイトを作成したい」 - about as plain a `CONNECT_WEBSITE` request as exists -
// matched NOTHING, because `作[りっ]` only covers the 和語 conjugations 「作りたい」/
// 「作った」 and never the 漢語 compound 「作成」 (the `作` is followed by `成`, not
// by `り`/`っ`). The site noun matched, the verb did not, so the whole matcher
// declined and the user got §11.5's fixed apology for the feature's single most
// common opening sentence. The dataset's own 「サブドメイン作成」 (eval-150,
// `CREATE_SUBDOMAIN`) is unaffected: it has no site noun and no provider, and
// `hasBareDomainMention` strips `サブドメイン` before looking for 「ドメイン」, so
// `matchConnectWebsite` still declines it and `matchCreateSubdomain` still wins.
const PUBLISH_VERB_PATTERN =
  /公開|つな[ぐぎげ]|接続|使[いえっう]|作[りっ]|作成|制作|開設|デプロイ|リリース|立ち上げ|立てた|出したい|付けたい|にしたい|にする/

/**
 * 「ドメイン」 alone (without a site noun or a recognised provider) is also
 * accepted alongside a publish verb - dataset cases like 「自分で用意した
 * サーバーに独自ドメインをつなぎたいんですけど」 name neither a site noun nor a known
 * provider. `サブドメイン` is stripped first because it literally contains the
 * substring `ドメイン` (`サブ` + `ドメイン`) and must never itself count as this
 * "domain" signal - that would steal every `CREATE_SUBDOMAIN` case that also
 * happens to use a `CONNECT_WEBSITE`-shaped verb (e.g. 「サブドメインを作りたい」).
 */
function hasBareDomainMention(input: string): boolean {
  return /ドメイン/.test(input.replace(/サブドメイン/g, ''))
}

/**
 * Fires either on a site noun/domain mention ("Webサイトを公開したい",
 * "独自ドメインをつなぎたい") combined with a publish verb, or on a recognised
 * web-hosting provider name alone with no other context (bare "vercel",
 * "cloudflare", ...) - `isEffectivelyBareMention` is what keeps that second
 * branch from also firing on an `out_of_scope` sentence that merely mentions
 * a provider while asking about pricing/comparison (see its own comment).
 */
/**
 * A generic 「DNSレコード」 mention (no specific record type - `matchRecordIntent`
 * already claims every case that names one) is as strong a CONNECT_WEBSITE
 * signal as a recognised provider: 「VerselのDNSレコードをドメインに設定したい」
 * ("Versel" is a misspelling of Vercel, deliberately NOT fuzzy-matched as a
 * provider - see the team-lead's explicit instruction on `isEffectivelyBareMention`)
 * must still classify on 「DNSレコード」＋「設定したい」 alone.
 */
/**
 * A DNS mention, with or without the word 「レコード」.
 *
 * ⚠️ `\bDNS\b` also matches inside 「DNSレコード」 (JS `\w` is ASCII-only, so the
 * boundary holds before the katakana), which is why one pattern covers both
 * spellings. The bare form was added after a browser report: 「CloudflareでDNSを
 * 変えたい」 and 「DNSの設定を変えたい」 matched no matcher at all, because the
 * mention pattern demanded the literal word 「レコード」 - a distinction a user
 * has no reason to make.
 */
const DNS_MENTION_PATTERN = /\bDNS\b/i

/**
 * 「ネームサーバー」 is `matchChangeNameserver`'s own signal, and that matcher
 * runs AFTER this one. Before the bare-DNS mention and the `変え` verb existed,
 * that ordering was harmless - nothing in `matchConnectWebsite` could fire on a
 * nameserver sentence. Both additions broke that: 「ネームサーバーをCloudflareの
 * ものに変えたい」 (dataset eval-169) was claimed by CONNECT_WEBSITE via
 * provider + 変え. This exclusion hands every nameserver sentence back, the same
 * "strip the more specific token first" idiom `hasBareDomainMention` uses for
 * サブドメイン.
 *
 * It is the better answer regardless of the label: CHANGE_NAMESERVER's Playbook
 * carries `NAMESERVER_CHANGE_WARNING` (changing nameservers silently drops the
 * DNS records configured here, and stops mail), and asks no question, whereas
 * CONNECT_WEBSITE would ask 「どのサービスで公開しますか」 about a provider the
 * sentence already named. Both intents resolve to the same DNS_NAMESERVER
 * screen, so only the wording and that warning actually differ.
 *
 * ⚠️ Known dataset-label disagreement this re-opens: eval-034
 * 「cloudflareにネームサーバー変更したい」 is labelled CONNECT_WEBSITE while
 * eval-169 「ネームサーバーをCloudflareのものに変えたい」 is labelled
 * CHANGE_NAMESERVER, though the two sentences mean the same thing. No rule can
 * satisfy both; this one satisfies eval-169 and accepts eval-034 as a miss.
 */
const NAMESERVER_MENTION_PATTERN = /ネームサーバー|ねーむさーばー/

function hasDnsMention(input: string): boolean {
  if (NAMESERVER_MENTION_PATTERN.test(input)) return false
  return DNS_MENTION_PATTERN.test(input)
}

/**
 * Configuration verbs accepted ONLY alongside a recognised provider or a DNS
 * mention (see `matchConnectWebsite`'s use of this). Deliberately kept out of
 * `PUBLISH_VERB_PATTERN`: on their own these words are shared with
 * VIEW_DOMAIN/VERIFY_DOMAIN/CREATE_SUBDOMAIN and would steal their cases.
 *
 * `変え` (変えたい/変える/変えられ) sits alongside the 漢語 `変更` for the same
 * reason `作成` had to join `作りたい` - the colloquial and the formal form are
 * the same request, and recognising only one of them is an arbitrary split
 * that a user cannot see. 「CloudflareでDNSを変えたい」 is the reported case.
 */
const PROVIDER_CONFIG_VERB_PATTERN = /設定|変更|変え|編集|修正|追加|削除|直したい/

function matchConnectWebsite(input: string): RuleBasedGuess | null {
  const providerMatch = detectProviderMatch(input, 'web')
  const verb = firstMatch(input, [PUBLISH_VERB_PATTERN])
  const siteNoun = firstMatch(input, [SITE_NOUN_PATTERN])
  const dnsRecordMention = hasDnsMention(input) ? 'DNS' : null

  // A provider name / a generic 「DNSレコード」 mention plus a bare configuration
  // verb ("netlifyにこのドメインを設定したい", "DNSレコードをドメインに設定したい") also
  // counts as a verb, but ONLY alongside one of those two - seeing 「設定」 alone
  // is otherwise no more specific to this intent than to
  // VIEW_DOMAIN/VERIFY_DOMAIN/CREATE_SUBDOMAIN (see PUBLISH_VERB_PATTERN's comment).
  //
  // ⚠️ `変更|編集|修正|追加|削除` were added after a browser report:
  // 「CloudflareでDNSレコードを変更したい」 - a plainly in-scope request naming both
  // a known provider AND a DNS record - matched no matcher at all and fell to
  // §11.5's fixed apology, because 「変更」 appeared in no vocabulary list
  // anywhere. Editing a record is the same kind of request as configuring one;
  // treating only 「設定」 as a configuration verb was an arbitrary split. The
  // gate is unchanged, so this still cannot fire on a sentence that names
  // neither a provider nor a DNS record.
  // The nameserver exclusion applies to the whole config-verb branch, not just
  // to the DNS mention: a nameserver sentence naming a provider (eval-169)
  // would otherwise fire here via provider + 変え. See
  // `NAMESERVER_MENTION_PATTERN`'s own doc for why CHANGE_NAMESERVER is the
  // better answer for every sentence that says 「ネームサーバー」.
  const configVerb = NAMESERVER_MENTION_PATTERN.test(input) ? null : firstMatch(input, [PROVIDER_CONFIG_VERB_PATTERN])
  const providerConfigVerb = (providerMatch ?? dnsRecordMention) && configVerb ? configVerb : null
  const effectiveVerb = verb ?? providerConfigVerb

  if (effectiveVerb && (siteNoun || providerMatch || dnsRecordMention || (verb && hasBareDomainMention(input)))) {
    const slots: Record<string, string> = {}
    const matchedTerms = [effectiveVerb]
    if (siteNoun) matchedTerms.push(siteNoun)
    if (dnsRecordMention) matchedTerms.push(dnsRecordMention)
    if (providerMatch) {
      slots.provider = providerMatch.id
      matchedTerms.push(providerMatch.term)
    }
    return guess('CONNECT_WEBSITE', slots, matchedTerms)
  }

  if (providerMatch && isEffectivelyBareMention(input, providerMatch.term)) {
    return guess('CONNECT_WEBSITE', { provider: providerMatch.id }, [providerMatch.term])
  }

  return null
}

/**
 * No verb requirement (unlike v1 of this matcher): dataset cases include a
 * completely bare 「ネームサーバー」 and phrasings with no literal 「変更」 at all
 * (「他社のネームサーバーに変えたい」, 「レジストラのネームサーバーから独自のものに切り替えたい
 * んですけど」). `looksLikeExplainQuestion` is the only gate, so 「ねーむさーばー
 * ってどういう意味ですか」 (an `explanation`-category case) is correctly left for
 * `matchExplainDns` instead.
 */
function matchChangeNameserver(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/ネームサーバー/, /ねーむさーばー/, /\bNS\b/i])
  if (!marker) return null
  if (looksLikeExplainQuestion(input)) return null
  return guess('CHANGE_NAMESERVER', {}, [marker])
}

/** `EXPLAIN_DNS` marker list is intentionally broader than `looksLikeExplainQuestion` (bare 「何」/「とは」/「意味」 is fine here - nothing downstream of this matcher competes for the same text). */
const EXPLAIN_DNS_TOPIC_PATTERN = /DNS|ネームサーバー|ねーむさーばー|サブドメイン|ゾーン|名前解決|whois|更新期限|AuthInfo/i
const EXPLAIN_MARKER_PATTERN = /とは|何|意味/

function matchExplainDns(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [EXPLAIN_DNS_TOPIC_PATTERN])
  if (!marker) return null
  if (!EXPLAIN_MARKER_PATTERN.test(input)) return null
  return guess('EXPLAIN_DNS', {}, [marker])
}

/**
 * "The domain is already mine" - past tense only. Every alternative carries a
 * `(?!い)` where the polite volitional form is a literal prefix of the past
 * form (`取得したい` / `購入したい` / `契約したい`), the same trap
 * `matchViewDomain`'s own `/取得した(?!い)/` documents: without it, every
 * `PURCHASE_DOMAIN` case would read as an already-completed acquisition.
 *
 * ⚠️ Every 和語 past form is listed twice, plain AND polite: 「取得しました」 does
 * NOT contain the substring 「取得した」 (it is 取得・し・まし・た), so a pattern
 * written only for the plain form silently misses the more polite half of the
 * corpus - dataset eval-515 「ドメインを取得しました。手順を教えてください」 matched
 * nothing at all until 「取得しました」 was added. Same class of miss as
 * `PUBLISH_VERB_PATTERN`'s 「作りたい」 vs 「作成したい」 split.
 */
const DOMAIN_ACQUIRED_PATTERN =
  /取得した(?!い)|取得しました|取得済み|取得後|購入した(?!い)|購入しました|買った|買いました|契約した(?!い)|契約しました|申し込んだ|申し込みました|取れた|手に入れた/

/**
 * "...so what do I do now?" - a question about the NEXT action, with no concrete
 * goal named.
 *
 * ⚠️ Deliberately excludes 「確認」: 「取得したドメインを確認したい」 (dataset
 * eval-284) is `VIEW_DOMAIN`, and it carries the acquisition marker above, so
 * anything that also matched 確認 here would steal it.
 */
const NEXT_STEP_QUESTION_PATTERN =
  /次[はにのも]?何|次のステップ|何をすれ|何をした|何から|どうすれ|どうしたら|流れ|手順|やること|やるべき|始めれ|どこから/

/**
 * True when the message says BOTH "I already have this domain" and "what comes
 * next" - the 「ドメインを取得したが公開のために何をすれば良い」 family.
 *
 * Exported because two very different layers need the same reading:
 * `matchPostPurchaseNextSteps` below (to claim the turn when no concrete goal
 * was named), and `useAssistantChat.ts`'s `modelRouteContradictsRuleBasedIntent`
 * (to treat this as strong enough evidence to outrank the model even when no
 * slot value was extracted - a 0.6B model reads 「取得した」 as 「取得したい」 and
 * sends the user to ドメイン検索, i.e. back to buying the domain they just
 * bought). Writing the predicate once is what keeps those two readings from
 * drifting apart.
 *
 * The literal word 「ドメイン」 is required as a third condition, purely as a
 * false-positive guard for the corpus's `out_of_scope` cases: without it, an
 * off-topic 「先週買ったばかりなのにどうすればいいですか」 would land in a Playbook.
 */
export function hasPostAcquisitionSignal(normalizedInput: string): boolean {
  if (!/ドメイン/.test(normalizedInput)) return false
  if (!DOMAIN_ACQUIRED_PATTERN.test(normalizedInput)) return false
  return NEXT_STEP_QUESTION_PATTERN.test(normalizedInput)
}

/**
 * The 「取得したけど次は何を？」 hub. Runs LAST (see `INTENT_MATCHERS`) on purpose:
 * every other matcher above it recognises a CONCRETE goal, and a concrete goal
 * is always the better answer than the hub, even when the sentence also happens
 * to say "I already got the domain". Concretely:
 * - 「ドメインを取得したが公開のために何をすれば良い」 names 公開, so
 *   `matchConnectWebsite` claims it and the user gets the Web-publishing
 *   walkthrough directly rather than being asked what they want.
 * - 「ドメインを取得したのですが更新はどうすればいいですか」 stays `RENEW_DOMAIN`.
 * Only a sentence that names no goal at all reaches here.
 */
function matchPostPurchaseNextSteps(input: string): RuleBasedGuess | null {
  if (!hasPostAcquisitionSignal(input)) return null
  const acquired = firstMatch(input, [DOMAIN_ACQUIRED_PATTERN]) ?? ''
  const question = firstMatch(input, [NEXT_STEP_QUESTION_PATTERN]) ?? ''
  return guess('POST_PURCHASE_NEXT_STEPS', {}, [acquired, question])
}

function matchCreateSubdomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/サブドメイン/, /\bwww\b/i])
  if (!marker) return null
  return guess('CREATE_SUBDOMAIN', {}, [marker])
}

/**
 * Markers narrowed to avoid stealing other domain-lifecycle intents' own
 * vocabulary: 「自分の」 alone is too broad (`SEARCH_DOMAIN`'s 「自分の名前で
 * ドメインが取れるか知りたい」 also says 「自分の」) so it is only accepted near a
 * listing/viewing verb; 「取得した」 (past tense, "already obtained") must not
 * also match `PURCHASE_DOMAIN`'s "取得したい" (present tense, "want to
 * obtain") - the negative lookahead `(?!い)` is what keeps them apart, since
 * "取得した" is a literal prefix of "取得したい".
 */
function matchViewDomain(input: string): RuleBasedGuess | null {
  // ⚠️ `/取得した(?!い)/` below is also the strongest marker in
  // `hasPostAcquisitionSignal`, and this matcher runs FIRST, so without this
  // guard 「ドメインを取得したけど次は何をすればいい？」 would be answered with the
  // 取得済みドメイン一覧 - a screen that shows the user what they already know and
  // answers nothing they asked. The signal needs BOTH the past-tense
  // acquisition AND a "what next" question, and none of this matcher's own
  // cases carry the second half (「取得したドメインを確認したい」, eval-284, asks to
  // SEE the domain, not what to do with it), so handing those sentences to
  // `matchPostPurchaseNextSteps` costs this intent nothing.
  if (hasPostAcquisitionSignal(input)) return null
  const marker = firstMatch(input, [
    /自分の.{0,15}(一覧|見たい|確認|まとめて)/,
    /自分が.{0,10}持ってる/,
    /取得済み/,
    /取得した(?!い)/,
    /一覧/,
    /マイページ/,
    /契約中/,
    /契約内容/,
    /所有ドメイン/,
    /今持ってる/,
    /有効期限を見/,
    /設定状況/,
    /ステータス/,
    /詳細/,
    /詳しく/,
    /情報/,
  ])
  if (!marker) return null
  return guess('VIEW_DOMAIN', {}, [marker])
}

/**
 * Checked before `PURCHASE_DOMAIN`/`SEARCH_DOMAIN`: dataset cases like
 * 「AuthInfoコードが欲しい」 and 「移管に必要な認証コードを取得したい」 also match those two
 * intents' own "want" vocabulary ("欲しい"/"取得したい") but are `TRANSFER_DOMAIN`.
 */
function matchTransferDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [
    /移管/,
    /AuthInfo/i,
    /レジストラ.{0,10}(移し|移動)/,
    /管理会社.{0,10}変え/,
    /ドメイン.{0,10}(移したい|移動させ)/,
  ])
  if (!marker) return null
  return guess('TRANSFER_DOMAIN', {}, [marker])
}

function matchPurchaseDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/取得したい/, /購入/, /買いたい/, /買う/, /申し込/, /ドメイン契約/])
  if (!marker) return null
  return guess('PURCHASE_DOMAIN', {}, [marker])
}

function matchSearchDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [
    /探し/,
    /探す/,
    /検索/,
    /見つけ/,
    /空[いき]/,
    /調べ/,
    /取れ/,
    /選べる/,
    /取得可能/,
    // ⚠️ 「a.comは取得できる?」 - an availability question, reported from the
    // browser. `取得可能` was covered but the far more natural 「取得できる」/
    // 「取得できますか」 was not, and `PURCHASE_DOMAIN`'s own `/取得したい/`
    // (present tense "want to") does not match it either, so the question fell
    // through every matcher. The `(?!る)` on 取得でき is unnecessary - 取得できる
    // and 取得できますか share the 取得でき stem - but the ORDER matters: this
    // matcher runs after `matchPurchaseDomain`, so 「取得したい」 still reaches
    // PURCHASE_DOMAIN first and only the "can I?" phrasing lands here.
    /取得でき/,
    // 「ドメイン名の候補が欲しい」 - candidate-seeking, not the plain "want to buy
    // this specific domain" of PURCHASE_DOMAIN, and must never be VIEW_DOMAIN.
    /候補/,
    /考えて/,
    /提案/,
    // ⚠️ "Show me more" follow-ups. Reported: after a candidate list was shown,
    // 「さらに見たい」 matched NOTHING and dead-ended at §11.5's fixed apology.
    // Only phrasings containing 「候補」 were recognised, so 「他の候補」 worked
    // while 「さらに見たい」 did not - a distinction no user makes.
    //
    // `classifyIntent` is pure and sees only the current message, never the
    // turn before it, so "more of WHAT" cannot be resolved from context here.
    // In a domain service the overwhelmingly likely referent is candidates,
    // and SEARCH_DOMAIN is also the safe landing: its Playbook asks nothing
    // and offers the candidate search, so a wrong guess costs the user one
    // click rather than a dead end. The alternative - leaving them on §11.5's
    // apology - is strictly worse for every reading.
    //
    // The quantifier must be paired with a "want/see" verb: a bare 「もっと」
    // or 「他の」 is far too broad on its own.
    /(さらに|もっと|他に?の?|別の|次の)[\s\S]{0,8}(見たい|見せて|欲しい|ほしい|ありますか|ある\?|知りたい)/,
  ])
  if (!marker) return null
  return guess('SEARCH_DOMAIN', {}, [marker])
}

function matchRetireDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [
    /もう使わない/,
    /解約/,
    /廃止/,
    /手放/,
    /復旧/,
    /削除/,
    /やめたい/,
    /元に戻/,
  ])
  if (!marker) return null
  return guess('RETIRE_DOMAIN', {}, [marker])
}

function matchRenewDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/更新/, /期限/, /延長/, /延ばし/])
  if (!marker) return null
  return guess('RENEW_DOMAIN', {}, [marker])
}

/** The `ADD_TXT` record dispatcher (`matchRecordIntent`, checked earlier) already claims every case that names TXT explicitly - this only covers "prove/verify ownership" phrasing that never mentions a DNS record. */
function matchVerifyDomain(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/所有権/, /証明したい/, /SSL証明書/i, /ドメイン認証/, /Search Console/i, /確認用のコード/])
  if (!marker) return null
  return guess('VERIFY_DOMAIN', {}, [marker])
}

function matchLoginHelp(input: string): RuleBasedGuess | null {
  const marker = firstMatch(input, [/ログイン/, /サインイン/, /アカウント/, /新規登録/, /パスワード/, /会員登録/])
  if (!marker) return null
  return guess('LOGIN_HELP', {}, [marker])
}

/**
 * Priority order (see each matcher's own comment for the specific dataset
 * collision it resolves by being ordered where it is):
 * 1. `TROUBLESHOOT_DNS` first - "already configured but broken" always beats
 *    whatever record/provider/nameserver word is also in the sentence.
 * 2. The record dispatcher - an explicit record-type name beats a co-occurring
 *    `SETUP_EMAIL`/`CONNECT_WEBSITE` verb.
 * 3. `SETUP_EMAIL` before `CONNECT_WEBSITE` - 「メール」/a mail provider beats a
 *    shared verb like 「使いたい」.
 * 4. `CHANGE_NAMESERVER`, then `EXPLAIN_DNS`/`CREATE_SUBDOMAIN`.
 * 5. The domain-lifecycle intents, most-specific-marker-first
 *    (`VIEW_DOMAIN`/`TRANSFER_DOMAIN` before `PURCHASE_DOMAIN`/`SEARCH_DOMAIN`,
 *    since "取得済み"/"欲しい"(AuthInfo) collide with "取得したい"/"欲しい"(purchase)).
 * 6. `LOGIN_HELP` - its vocabulary never collides with anything above.
 * 7. `POST_PURCHASE_NEXT_STEPS` truly last: it is the "no concrete goal was
 *    named" hub, so every matcher above it - each of which recognises a
 *    concrete goal - must get its chance first. See its own comment.
 */
const INTENT_MATCHERS: readonly Matcher[] = [
  matchTroubleshootDns,
  matchRecordIntent,
  matchSetupEmail,
  matchConnectWebsite,
  matchChangeNameserver,
  matchExplainDns,
  matchCreateSubdomain,
  matchViewDomain,
  matchTransferDomain,
  matchPurchaseDomain,
  matchSearchDomain,
  matchRetireDomain,
  matchRenewDomain,
  matchVerifyDomain,
  matchLoginHelp,
  matchPostPurchaseNextSteps,
]

/**
 * Classifies already-normalized user text (`security/inputGuard.ts`'s
 * `normalizeUserInput` output) into an `IntentId` + slots, or `null` when
 * nothing in `INTENT_MATCHERS` fires. Pure and synchronous - safe to call
 * from anywhere, including outside React.
 */
export function classifyIntent(normalizedInput: string): RuleBasedGuess | null {
  for (const matcher of INTENT_MATCHERS) {
    const result = matcher(normalizedInput)
    if (result) return result
  }
  return null
}
