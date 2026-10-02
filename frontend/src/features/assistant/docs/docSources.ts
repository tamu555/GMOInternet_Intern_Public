/**
 * Curated first-party documentation registry (design contract §5.1,
 * `.agents/docs/research/assistant-doc-sources.md`).
 *
 * This constant is the ONLY set of external URLs this feature may ever
 * surface to a user. The LLM never sees this file and can never add to it -
 * `docResolver.ts` looks entries up by `providerId`/`topic`/`recordType`
 * only, never by anything the model wrote. Every entry was verified live
 * (fetched, HTTP status recorded, `<title>` captured) on 2026-08-26; see the
 * research report above for the full verification log, rejected candidates,
 * and stability-risk notes.
 *
 * Do not hand-edit a `url`/`hostname` pair without re-verifying it live and
 * updating the research report - a mismatch here is exactly what
 * `docSources.test.ts` exists to catch before it ships.
 */
import { DNS_RECIPES } from '../../dns/recipes'

export type DocTopic = 'custom-domain' | 'nameserver' | 'verification' | 'email' | 'glossary'

export interface AssistantDocSource {
  id: string
  /** A `DNS_RECIPES` id, or `null` for provider-agnostic glossary entries. */
  providerId: string | null
  topic: DocTopic
  /** Japanese, written for beginners. */
  title: string
  /** `https://` only, compile-time constant. */
  url: string
  hostname: string
  language: 'ja' | 'en'
  publisher: string
}

/**
 * Transcribed verbatim from `.agents/docs/research/assistant-doc-sources.md`
 * §1: 26 rows - 14 provider-specific across the 8 `DNS_RECIPES` ids, 12
 * glossary/terminology entries. (An earlier draft of the report's own
 * summary prose said 24 / 10 glossary, undercounting its own table by 2;
 * the report has since been corrected to 26 - see `docSources.test.ts`,
 * which asserts the real count rather than trusting a summary line.) Every
 * field below (`id`, `providerId`, `topic`, `title`, `url`, `hostname`,
 * `language`, `publisher`) is copied character-for-character from that
 * table; nothing here was shortened, invented, or "fixed".
 *
 * Note for the UI wave: `glossary-dns-propagation`'s `url` is a PDF
 * (`.pdf`), not an HTML page - `DocSourceCard` must not assume every entry
 * opens as a normal web page (e.g. no `<title>` to double-check against,
 * different rendering/behaviour on click). It is also the highest link-rot
 * risk entry in this table per the research report §4 (a 2011
 * conference-slide deck under `/tech/material/`); a future maintenance pass
 * should re-verify it first if any entry ever needs re-checking.
 */
export const ASSISTANT_DOC_SOURCES: readonly AssistantDocSource[] = [
  {
    id: 'vercel-custom-domain',
    providerId: 'vercel',
    topic: 'custom-domain',
    title: 'Vercel: 独自ドメインの追加と設定方法',
    url: 'https://vercel.com/docs/domains/working-with-domains/add-a-domain',
    hostname: 'vercel.com',
    language: 'en',
    publisher: 'Vercel Inc.',
  },
  {
    id: 'vercel-manage-dns-records',
    providerId: 'vercel',
    topic: 'custom-domain',
    title: 'Vercel: DNS レコードの管理画面の使い方',
    url: 'https://vercel.com/docs/domains/managing-dns-records',
    hostname: 'vercel.com',
    language: 'en',
    publisher: 'Vercel Inc.',
  },
  {
    id: 'netlify-external-dns',
    providerId: 'netlify',
    topic: 'custom-domain',
    title: 'Netlify: 外部の DNS 事業者でドメインを設定する',
    url: 'https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/',
    hostname: 'docs.netlify.com',
    language: 'en',
    publisher: 'Netlify, Inc.',
  },
  {
    id: 'github-pages-custom-domain',
    providerId: 'github-pages',
    topic: 'custom-domain',
    title: 'GitHub Pages: 独自ドメインの設定方法',
    url: 'https://docs.github.com/ja/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site',
    hostname: 'docs.github.com',
    language: 'ja',
    publisher: 'GitHub, Inc.',
  },
  {
    id: 'github-pages-verification',
    providerId: 'github-pages',
    topic: 'verification',
    title: 'GitHub Pages: 独自ドメインの所有権確認（TXT レコード）',
    url: 'https://docs.github.com/ja/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages',
    hostname: 'docs.github.com',
    language: 'ja',
    publisher: 'GitHub, Inc.',
  },
  {
    id: 'google-workspace-mx',
    providerId: 'google-workspace',
    topic: 'email',
    title: 'Google Workspace: メール受信用の MX レコードを設定する',
    url: 'https://knowledge.workspace.google.com/admin/domains/set-up-mx-records-for-google-workspace?hl=ja',
    hostname: 'knowledge.workspace.google.com',
    language: 'ja',
    publisher: 'Google LLC',
  },
  {
    id: 'google-workspace-spf',
    providerId: 'google-workspace',
    topic: 'email',
    title: 'Google Workspace: 送信ドメイン認証（SPF）の TXT レコードを設定する',
    url: 'https://knowledge.workspace.google.com/admin/security/set-up-spf?hl=ja',
    hostname: 'knowledge.workspace.google.com',
    language: 'ja',
    publisher: 'Google LLC',
  },
  {
    id: 'microsoft-365-dns-records',
    providerId: 'microsoft-365',
    topic: 'email',
    title: 'Microsoft 365: メール用の DNS レコード（MX・SPF）を追加する',
    url: 'https://learn.microsoft.com/ja-jp/microsoft-365/admin/get-help-with-domains/create-dns-records-at-any-dns-hosting-provider?view=o365-worldwide',
    hostname: 'learn.microsoft.com',
    language: 'ja',
    publisher: 'Microsoft',
  },
  {
    id: 'microsoft-365-verification',
    providerId: 'microsoft-365',
    topic: 'verification',
    title: 'Microsoft 365: ドメインの所有権を確認する（TXT レコード）',
    url: 'https://learn.microsoft.com/ja-jp/microsoft-365/admin/setup/add-domain?view=o365-worldwide',
    hostname: 'learn.microsoft.com',
    language: 'ja',
    publisher: 'Microsoft',
  },
  {
    id: 'sakura-rental-dns-records',
    providerId: 'sakura-rental',
    topic: 'custom-domain',
    title: 'さくらのレンタルサーバ: 独自ドメインに必要な DNS レコード一覧',
    url: 'https://help.sakura.ad.jp/domain/2865/',
    hostname: 'help.sakura.ad.jp',
    language: 'ja',
    publisher: 'さくらインターネット株式会社',
  },
  {
    id: 'sakura-rental-zone-edit',
    providerId: 'sakura-rental',
    topic: 'custom-domain',
    title: 'さくらのレンタルサーバ: ドメインのゾーン情報（DNSレコード）を編集する手順',
    url: 'https://help.sakura.ad.jp/rs/2852/',
    hostname: 'help.sakura.ad.jp',
    language: 'ja',
    publisher: 'さくらインターネット株式会社',
  },
  {
    id: 'xserver-nameserver',
    providerId: 'xserver',
    topic: 'nameserver',
    title: 'エックスサーバー: ネームサーバーの設定方法',
    url: 'https://www.xserver.ne.jp/manual/man_domain_namesever_setting.php',
    hostname: 'www.xserver.ne.jp',
    language: 'ja',
    publisher: 'エックスサーバー株式会社',
  },
  {
    id: 'xserver-other-registrar-faq',
    providerId: 'xserver',
    topic: 'nameserver',
    title: 'エックスサーバー: 他社で取得したドメインを使う場合のネームサーバー設定',
    url: 'https://www.xserver.ne.jp/support/faq/domain_multi_otherservice.php',
    hostname: 'www.xserver.ne.jp',
    language: 'ja',
    publisher: 'エックスサーバー株式会社',
  },
  {
    id: 'cloudflare-nameserver',
    providerId: 'cloudflare',
    topic: 'nameserver',
    title: 'Cloudflare: ネームサーバーを変更してドメインを追加する（フルセットアップ）',
    url: 'https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
    hostname: 'developers.cloudflare.com',
    language: 'en',
    publisher: 'Cloudflare, Inc.',
  },
  {
    id: 'glossary-dns',
    providerId: null,
    topic: 'glossary',
    title: 'DNS（ドメインネームシステム）とは',
    url: 'https://jprs.jp/glossary/index.php?ID=0017',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS（日本レジストリサービス）',
  },
  {
    id: 'glossary-name-resolution',
    providerId: null,
    topic: 'glossary',
    title: '名前解決とは',
    url: 'https://jprs.jp/glossary/index.php?ID=0084',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-nameserver',
    providerId: null,
    topic: 'glossary',
    title: 'ネームサーバーとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0157',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-a-record',
    providerId: null,
    topic: 'glossary',
    title: 'A レコードとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0161',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-aaaa-record',
    providerId: null,
    topic: 'glossary',
    title: 'AAAA レコードとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0162',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-cname-record',
    providerId: null,
    topic: 'glossary',
    title: 'CNAME レコードとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0212',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-mx-record',
    providerId: null,
    topic: 'glossary',
    title: 'MX レコードとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0163',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-txt-record',
    providerId: null,
    topic: 'glossary',
    title: 'TXT レコードとは',
    url: 'https://jprs.jp/glossary/index.php?ID=0223',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-ttl',
    providerId: null,
    topic: 'glossary',
    title: 'TTL とは',
    url: 'https://jprs.jp/glossary/index.php?ID=0136',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    // ⚠️ PDF, not HTML - see the top-of-file note. Highest link-rot risk in
    // this registry (research report §4): a 2011 conference-slide deck.
    id: 'glossary-dns-propagation',
    providerId: null,
    topic: 'glossary',
    title: 'DNS の反映（いわゆる「浸透」）にかかる時間について',
    url: 'https://jprs.jp/tech/material/iw2011-lunch-L1-01.pdf',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-whois',
    providerId: null,
    topic: 'glossary',
    title: 'WHOIS とは',
    url: 'https://jprs.jp/glossary/index.php?ID=0063',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
  {
    id: 'glossary-domain-transfer',
    providerId: null,
    topic: 'glossary',
    title: 'ドメインの移管（管理事業者の変更）とは',
    url: 'https://jprs.jp/about/dom-rule/agent-change/index.html',
    hostname: 'jprs.jp',
    language: 'ja',
    publisher: 'JPRS',
  },
]

/** The distinct hostnames present in `ASSISTANT_DOC_SOURCES` - the allowlist `DocSourceCard` may render. */
export const DOC_PUBLISHER_HOSTS: readonly string[] = Array.from(
  new Set(ASSISTANT_DOC_SOURCES.map((source) => source.hostname)),
)

/** Every id `DNS_RECIPES` defines, for `docSources.test.ts`'s `providerId` cross-check. */
export const KNOWN_RECIPE_IDS: readonly string[] = DNS_RECIPES.map((recipe) => recipe.id)

export function findDocSource(id: string): AssistantDocSource | undefined {
  return ASSISTANT_DOC_SOURCES.find((source) => source.id === id)
}
