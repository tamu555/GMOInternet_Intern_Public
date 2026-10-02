import { describe, expect, it } from 'vitest'
import { classifyIntent, hasPostAcquisitionSignal } from './ruleBasedIntent'
// `?raw` (typed by the `vite/client` ambient declarations already in
// tsconfig.app.json's `types`) rather than `node:fs` - this package's
// tsconfig has no Node type roots, and reading the dataset this way avoids
// needing any (out of scope for this task).
import rawDataset from '../../../../e2e/assistant-eval/dataset.json?raw'

describe('classifyIntent', () => {
  it('classifies the headline "never dead-end" repro case', () => {
    // The exact input that used to dead-end at §11.5's fixed apology - see
    // the team-lead directive this module implements.
    const result = classifyIntent('ポートフォリオ用のWebサイトを公開したい')
    expect(result).not.toBeNull()
    expect(result?.intent).toBe('CONNECT_WEBSITE')
    expect(result?.slots).toEqual({})
  })

  it('returns null for genuinely unclassifiable text', () => {
    expect(classifyIntent('こんにちは')).toBeNull()
    expect(classifyIntent('今日はいい天気ですね')).toBeNull()
  })

  describe('CONNECT_WEBSITE', () => {
    it.each([
      'Webサイトを公開したい',
      'ホームページを作りたい',
      'サイトをこのドメインにつなぎたい',
      'サイトを接続したい',
      // ⚠️ 漢語 compounds, added after a browser report: 「Webサイトを作成したい」
      // matched NOTHING because `作[りっ]` only covers the 和語 conjugations
      // 「作りたい」/「作った」. The site noun matched, the verb did not, and the
      // feature's single most common opening sentence dead-ended at §11.5's
      // fixed apology.
      'Webサイトを作成したい',
      'ホームページを制作したい',
      'サイトを開設したい',
      'サイトをデプロイしたい',
    ])('classifies %s as CONNECT_WEBSITE with no provider slot', (input) => {
      const result = classifyIntent(input)
      expect(result?.intent).toBe('CONNECT_WEBSITE')
      expect(result?.slots.provider).toBeUndefined()
    })

    it('「サブドメイン作成」 still wins for CREATE_SUBDOMAIN despite the new 作成 verb (substring trap)', () => {
      // dataset eval-150. `matchConnectWebsite` runs first and now recognises
      // 作成, so this asserts it still declines: no site noun, no provider, and
      // `hasBareDomainMention` strips サブドメイン before looking for 「ドメイン」.
      expect(classifyIntent('サブドメイン作成')?.intent).toBe('CREATE_SUBDOMAIN')
      expect(classifyIntent('サブドメインを作成したい')?.intent).toBe('CREATE_SUBDOMAIN')
    })

    it('「メールアドレスを作成したい」 stays SETUP_EMAIL, not CONNECT_WEBSITE', () => {
      expect(classifyIntent('メールアドレスを作成したい')?.intent).toBe('SETUP_EMAIL')
    })

    it.each([
      ['Vercelで公開したい', 'vercel'],
      ['バーセルで公開したい', 'vercel'],
      ['Netlifyに接続したい', 'netlify'],
      ['ネトリファイを使いたい', 'netlify'],
      ['GitHub Pagesで公開したい', 'github-pages'],
      ['さくらのレンタルサーバーで公開したい', 'sakura-rental'],
      ['Xserverで使いたい', 'xserver'],
      ['エックスサーバーに接続したい', 'xserver'],
      ['Cloudflareを使いたい', 'cloudflare'],
      ['クラウドフレアで公開したい', 'cloudflare'],
    ] as const)('extracts the provider slot for %s -> %s', (input, providerId) => {
      const result = classifyIntent(input)
      expect(result?.intent).toBe('CONNECT_WEBSITE')
      expect(result?.slots.provider).toBe(providerId)
    })

    it('a provider name alone, with a publish verb but no explicit site noun, still resolves to CONNECT_WEBSITE (not SEARCH_DOMAIN)', () => {
      // ⚠️ Ambiguous-ordering regression guard: "Vercelで公開したい" has no
      // 「ドメイン」 token at all, so it could never satisfy SEARCH_DOMAIN's own
      // pattern - but this asserts CONNECT_WEBSITE is what actually fires,
      // not `null`.
      const result = classifyIntent('Vercelで公開したい')
      expect(result?.intent).toBe('CONNECT_WEBSITE')
      expect(result?.slots).toEqual({ provider: 'vercel' })
    })
  })

  describe('SETUP_EMAIL', () => {
    it.each(['メールを使いたい', 'メールの設定をしたい', 'メールを受信したい'])(
      'classifies %s as SETUP_EMAIL with no provider slot',
      (input) => {
        const result = classifyIntent(input)
        expect(result?.intent).toBe('SETUP_EMAIL')
        expect(result?.slots.provider).toBeUndefined()
      },
    )

    it.each([
      ['Google Workspaceでメールを使いたい', 'google-workspace'],
      ['グーグルワークスペースでメールを設定したい', 'google-workspace'],
      ['Microsoft 365でメールを使いたい', 'microsoft-365'],
      ['マイクロソフト365のメールを設定したい', 'microsoft-365'],
      ['Office 365でメールを受信したい', 'microsoft-365'],
    ] as const)('extracts the email provider slot for %s -> %s', (input, providerId) => {
      const result = classifyIntent(input)
      expect(result?.intent).toBe('SETUP_EMAIL')
      expect(result?.slots.provider).toBe(providerId)
    })

    it('a mail provider name with a "使いたい" verb resolves to SETUP_EMAIL, not CONNECT_WEBSITE', () => {
      // ⚠️ Ambiguous-ordering regression guard: "使いたい" is also a
      // CONNECT_WEBSITE publish verb - the explicit 「メール」 mention must win.
      const result = classifyIntent('Google Workspaceでメールを使いたい')
      expect(result?.intent).toBe('SETUP_EMAIL')
    })

    it('§21.3\'s own canonical example: 「メールをGoogle Workspaceにしたい」 (「〜にしたい」, not 「〜を使いたい」)', () => {
      const result = classifyIntent('メールをGoogle Workspaceにしたい')
      expect(result?.intent).toBe('SETUP_EMAIL')
      expect(result?.slots).toEqual({ provider: 'google-workspace' })
    })
  })

  describe('CHANGE_NAMESERVER', () => {
    it.each(['ネームサーバーを変更したい', 'NSを変更したい', 'ネームサーバーを変えたい'])(
      'classifies %s as CHANGE_NAMESERVER',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('CHANGE_NAMESERVER')
      },
    )

    it('a bare "ネームサーバーとは" (no 変更) does not classify as CHANGE_NAMESERVER', () => {
      expect(classifyIntent('ネームサーバーとは')?.intent).not.toBe('CHANGE_NAMESERVER')
      expect(classifyIntent('ネームサーバーとは')?.intent).toBe('EXPLAIN_DNS')
    })
  })

  describe('CONNECT_WEBSITE via a generic 「DNSレコード」 mention (misspelled brand names are never fuzzy-matched)', () => {
    it.each([
      // ⚠️ Browser report: this names a known provider AND a DNS record and is
      // about as in-scope as a sentence gets, yet it matched no matcher at all
      // and fell to §11.5's fixed apology - 「変更」 appeared in no vocabulary
      // list anywhere. Editing a record is the same kind of request as
      // configuring one.
      'CloudflareでDNSレコードを変更したい',
      'DNSレコードを編集したい',
      'VercelのDNSレコードを修正したい',
      'DNSレコードを追加したい',
    ])('%s classifies as CONNECT_WEBSITE (a configuration verb, gated on a provider or a DNS-record mention)', (input) => {
      expect(classifyIntent(input)?.intent).toBe('CONNECT_WEBSITE')
    })

    it.each([
      // ⚠️ Browser report: the mention pattern demanded the literal word
      // 「レコード」 and the verb list had 変更 but not the colloquial 変え, so a
      // plainly in-scope sentence matched nothing at all.
      'CloudflareでDNSを変えたい',
      'DNSを変えたい',
      'DNSの設定を変えたい',
    ])('%s classifies as CONNECT_WEBSITE (a bare DNS mention counts, and 変え is the same request as 変更)', (input) => {
      expect(classifyIntent(input)?.intent).toBe('CONNECT_WEBSITE')
    })

    it.each([
      // Every sentence naming ネームサーバー belongs to CHANGE_NAMESERVER, whose
      // Playbook carries the "this drops your DNS records and stops mail"
      // warning and asks no redundant question. Both intents resolve to the
      // same DNS_NAMESERVER screen, so only the wording and that warning differ.
      'Cloudflareでネームサーバーを変えたい',
      'ネームサーバーをCloudflareのものに変えたい',
      'ネームサーバーを変更したい',
    ])('%s stays CHANGE_NAMESERVER even though it names a provider and a config verb', (input) => {
      expect(classifyIntent(input)?.intent).toBe('CHANGE_NAMESERVER')
    })

    it('a bare DNS mention never steals an explanation question', () => {
      expect(classifyIntent('DNSとは何ですか')?.intent).toBe('EXPLAIN_DNS')
      expect(classifyIntent('DNSレコードとは何ですか')?.intent).toBe('EXPLAIN_DNS')
    })

    it('a bare configuration verb with neither a provider nor a DNS record still does NOT fire CONNECT_WEBSITE', () => {
      // The gate is what keeps 「変更」/「設定」 from stealing
      // VIEW_DOMAIN/VERIFY_DOMAIN/CREATE_SUBDOMAIN cases.
      expect(classifyIntent('ネームサーバーを変更したい')?.intent).toBe('CHANGE_NAMESERVER')
      expect(classifyIntent('サブドメインを追加したい')?.intent).toBe('CREATE_SUBDOMAIN')
    })

    it('「DNSレコードとは何ですか」 is EXPLAIN_DNS, not EXPLAIN_RECORD (NSレコード substring trap)', () => {
      // `NSレコード` is a literal substring of `DNSレコード`, so the record
      // dispatcher used to claim the generic word as an explicit NS-record
      // mention and answer with the meaning of "the NS record".
      expect(classifyIntent('DNSレコードとは何ですか')?.intent).toBe('EXPLAIN_DNS')
      // A real, standalone NS-record mention is unaffected.
      expect(classifyIntent('NSレコードとは何ですか')?.intent).toBe('EXPLAIN_RECORD')
    })

    it('「VerselのDNSレコードをドメインに設定したい」 classifies as CONNECT_WEBSITE with no provider slot', () => {
      // "Versel" is a misspelling of Vercel - it must NOT be recognised as a
      // provider (see isEffectivelyBareMention's module doc); the intent
      // still resolves via 「DNSレコード」＋「設定したい」 alone.
      const result = classifyIntent('VerselのDNSレコードをドメインに設定したい')
      expect(result?.intent).toBe('CONNECT_WEBSITE')
      expect(result?.slots.provider).toBeUndefined()
    })
  })

  describe('domain search/purchase/view (ordering)', () => {
    it.each(['ドメインを探したい', 'ドメインを検索したい', 'ドメインの候補を見つけたい'])(
      'classifies %s as SEARCH_DOMAIN',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('SEARCH_DOMAIN')
      },
    )

    it('"欲しい" alone is a SEARCH_DOMAIN marker, not PURCHASE_DOMAIN (dataset: 「欲しいドメイン名があるんですけど空いてるか調べる方法教えて」)', () => {
      const result = classifyIntent('欲しいドメインを見つけたい')
      expect(result?.intent).toBe('SEARCH_DOMAIN')
    })

    it('「ドメイン名の候補が欲しい」 is SEARCH_DOMAIN, never VIEW_DOMAIN (candidate-seeking, not "show me domains I already own")', () => {
      const result = classifyIntent('ドメイン名の候補が欲しい')
      expect(result?.intent).toBe('SEARCH_DOMAIN')
    })

    it.each(['ドメインを取得したい', 'ドメインを購入したい', 'ドメインを買いたい'])(
      'classifies %s as PURCHASE_DOMAIN',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('PURCHASE_DOMAIN')
      },
    )

    it.each(['自分のドメインを見たい', '取得済みドメインの一覧を見たい', 'マイページのドメインを確認したい', '取得済みのドメインを見たい'])(
      'classifies %s as VIEW_DOMAIN',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('VIEW_DOMAIN')
      },
    )

    it('"取得済み" (VIEW_DOMAIN) is never misread as PURCHASE_DOMAIN\'s "取得" marker', () => {
      // ⚠️ Ambiguous-ordering regression guard: PURCHASE_DOMAIN only matches
      // the specific phrase "取得したい", which "取得済み" does not contain.
      const result = classifyIntent('取得済みドメインの一覧を見たい')
      expect(result?.intent).toBe('VIEW_DOMAIN')
    })
  })

  describe('domain lifecycle', () => {
    it('classifies RETIRE_DOMAIN', () => {
      expect(classifyIntent('ドメインをもう使わないので解約したい')?.intent).toBe('RETIRE_DOMAIN')
      expect(classifyIntent('ドメインを廃止したい')?.intent).toBe('RETIRE_DOMAIN')
    })

    it('classifies RENEW_DOMAIN', () => {
      expect(classifyIntent('ドメインの有効期限を更新したい')?.intent).toBe('RENEW_DOMAIN')
      expect(classifyIntent('ドメインの期限を延長したい')?.intent).toBe('RENEW_DOMAIN')
    })

    it('RETIRE_DOMAIN is checked before RENEW_DOMAIN for an input naming both', () => {
      const result = classifyIntent('ドメインをもう使わないので更新もしない')
      expect(result?.intent).toBe('RETIRE_DOMAIN')
    })

    it('classifies TRANSFER_DOMAIN', () => {
      expect(classifyIntent('ドメインを移管したい')?.intent).toBe('TRANSFER_DOMAIN')
    })
  })

  describe('VERIFY_DOMAIN / TROUBLESHOOT_DNS', () => {
    it('classifies VERIFY_DOMAIN via 所有権', () => {
      expect(classifyIntent('ドメインの所有権を確認したい')?.intent).toBe('VERIFY_DOMAIN')
    })

    it('an explicit TXT-record mention resolves to ADD_TXT, not VERIFY_DOMAIN, even when combined with 確認/所有権 wording', () => {
      // The record dispatcher is checked before VERIFY_DOMAIN, so naming the
      // record type always wins - see matchRecordIntent's module comment and
      // the dataset cases 「所有権確認用のTXTレコードを追加してと言われました」/
      // 「このドメインの所有権を確認するためのTXTレコードを設定したい」 (both ADD_TXT).
      expect(classifyIntent('TXTレコードで確認してほしい')?.intent).toBe('ADD_TXT')
      expect(classifyIntent('所有権確認用のTXTレコードを追加してと言われました')?.intent).toBe('ADD_TXT')
    })

    it('ownership-verification phrasing with no record type stays VERIFY_DOMAIN', () => {
      expect(classifyIntent('ドメインの所有権を確認したい')?.intent).toBe('VERIFY_DOMAIN')
    })

    it.each(['設定が反映されない', 'サイトに繋がらない', 'ページが表示されない'])(
      'classifies %s as TROUBLESHOOT_DNS',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('TROUBLESHOOT_DNS')
      },
    )
  })

  describe('EXPLAIN_RECORD / EXPLAIN_DNS (ordering)', () => {
    it.each(['Aレコードって何', 'TXTレコードとは', 'CNAMEって何ですか', 'MXレコードの意味を教えて'])(
      'classifies %s as EXPLAIN_RECORD',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('EXPLAIN_RECORD')
      },
    )

    it.each(['DNSとは', 'DNSって何', 'ネームサーバーって何'])('classifies %s as EXPLAIN_DNS', (input) => {
      expect(classifyIntent(input)?.intent).toBe('EXPLAIN_DNS')
    })

    it('a record-type explanation is never misread as the generic EXPLAIN_DNS', () => {
      // ⚠️ Ambiguous-ordering regression guard: EXPLAIN_RECORD is checked
      // before EXPLAIN_DNS, so a record-specific question stays specific.
      expect(classifyIntent('TXTレコードとは')?.intent).toBe('EXPLAIN_RECORD')
    })

    it('a bare record-type mention with no とは/何/意味 does not classify as EXPLAIN_RECORD', () => {
      expect(classifyIntent('TXTレコードを追加したい')?.intent).not.toBe('EXPLAIN_RECORD')
    })
  })

  describe('LOGIN_HELP', () => {
    it.each(['ログインできません', 'アカウントを作りたい', 'サインインしたい', '新規登録したい'])(
      'classifies %s as LOGIN_HELP',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('LOGIN_HELP')
      },
    )
  })

  describe('matchedTerms', () => {
    it('is always a non-empty array on a successful match', () => {
      const result = classifyIntent('ドメインを探したい')
      expect(result?.matchedTerms.length).toBeGreaterThan(0)
    })
  })

  describe('ADD_* record intents', () => {
    it.each([
      ['AAAAレコードを追加したい', 'ADD_AAAA_RECORD'],
      ['IPv6アドレスを設定したい', 'ADD_AAAA_RECORD'],
      ['クアッドエーレコードって設定できますか', 'ADD_AAAA_RECORD'],
      ['Aレコードを追加したい', 'ADD_A_RECORD'],
      ['IPアドレスを設定したい', 'ADD_A_RECORD'],
      ['エーレコードって設定できますか', 'ADD_A_RECORD'],
      ['CNAMEレコードを追加したい', 'ADD_CNAME'],
      ['しーねーむレコードって何を入れればいいですか', 'ADD_CNAME'],
      ['MXレコードを追加したい', 'ADD_MX'],
      ['えむえっくすレコードってどこで設定しますか', 'ADD_MX'],
      ['TXTレコードを追加したい', 'ADD_TXT'],
      ['SPFレコードを設定したい', 'ADD_TXT'],
      ['てぃーえっくすてぃーレコードってどこで設定しますか', 'ADD_TXT'],
    ] as const)('classifies %s as %s', (input, expected) => {
      expect(classifyIntent(input)?.intent).toBe(expected)
    })

    it('AAAA is checked before A, so "AAAAレコード" is never misread as an A-record request (substring trap)', () => {
      expect(classifyIntent('AAAAレコードを追加したい')?.intent).toBe('ADD_AAAA_RECORD')
    })

    it('an explicit MX/TXT record name wins over a co-occurring SETUP_EMAIL verb', () => {
      expect(classifyIntent('メールを受け取れるようにMXレコードを設定したい')?.intent).toBe('ADD_MX')
      expect(classifyIntent('メールサービスからTXTレコードを追加するよう言われたんですけどどこで設定すればいいですか')?.intent).toBe(
        'ADD_TXT',
      )
    })

    it('"何を入れれば"/"、追加する場所を教えて" style questions stay ADD_* rather than EXPLAIN_RECORD', () => {
      expect(classifyIntent('TXTレコードって何を入れればいいの？場所だけ教えて')?.intent).toBe('ADD_TXT')
      expect(classifyIntent('MXレコードって何ですか、追加する場所を教えてください')?.intent).toBe('ADD_MX')
    })

    it('a bare "NSレコード" mention with no explain marker defers to CHANGE_NAMESERVER, since no ADD_NS_RECORD intent exists', () => {
      expect(classifyIntent('nsレコードを変更したい')?.intent).toBe('CHANGE_NAMESERVER')
    })
  })

  describe('CREATE_SUBDOMAIN', () => {
    it.each(['サブドメインを作りたい', 'wwwを作りたい', 'www.example.comを使えるようにしたい', 'サブドメイン'])(
      'classifies %s as CREATE_SUBDOMAIN',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('CREATE_SUBDOMAIN')
      },
    )

    it('"サブドメイン" is never misread as a bare 「ドメイン」 mention that would feed CONNECT_WEBSITE (substring trap)', () => {
      expect(classifyIntent('サブドメインを作りたい')?.intent).toBe('CREATE_SUBDOMAIN')
    })
  })

  describe('bare provider mentions', () => {
    it.each(['vercel', 'netlify', 'github pages', 'さくら', 'xserver', 'cloudflare'])(
      'classifies a bare web provider name %s as CONNECT_WEBSITE',
      (input) => {
        expect(classifyIntent(input)?.intent).toBe('CONNECT_WEBSITE')
      },
    )

    it.each(['google workspace', 'microsoft 365'])('classifies a bare mail provider name %s as SETUP_EMAIL', (input) => {
      expect(classifyIntent(input)?.intent).toBe('SETUP_EMAIL')
    })

    it('a provider name inside a longer sentence with no action verb (asking about pricing/comparison) does not fire an intent', () => {
      // ⚠️ False-positive guard: brand names must never be fuzzy-matched into
      // an intent just because they appear - only a genuinely bare mention
      // (or one paired with a real verb) counts. See isEffectivelyBareMention.
      expect(classifyIntent('エックスサーバーの料金プランを教えてください')).toBeNull()
      expect(classifyIntent('さくらのVPSとこのサービスどっちがいいですか')).toBeNull()
    })
  })

  /**
   * The 「ドメインを取得したが次に何をすれば良い」 family (team-lead report). Before
   * `matchPostPurchaseNextSteps` these split three ways, none of them useful:
   * a sentence naming 公開 was fine, one naming nothing fell through every
   * matcher to §11.5's apology, and one merely saying 「取得した」 was claimed by
   * `matchViewDomain` and answered with the domain list.
   */
  describe('post-acquisition "what next" hub', () => {
    it.each([
      'ドメインを買ったけど次は何をすればいい?',
      'ドメイン取得後の流れを教えて',
      'ドメインを取得したけど次に何をすればいいですか',
      'ドメインを取得したのですが手順を教えてください',
      'ドメインを契約したのですがこれから何をすればいいですか',
    ])('%s -> POST_PURCHASE_NEXT_STEPS', (input) => {
      expect(classifyIntent(input)?.intent).toBe('POST_PURCHASE_NEXT_STEPS')
    })

    it('a sentence that names a concrete goal keeps that goal - the hub only takes what nothing else claims', () => {
      // 公開 is named, so the user gets the Web-publishing answer (and its
      // walkthrough) directly instead of being asked what they want.
      expect(classifyIntent('ドメインを取得したが公開のために何をすれば良い')?.intent).toBe('CONNECT_WEBSITE')
      // 更新 is named, and `matchRenewDomain` runs before the hub.
      expect(classifyIntent('ドメインを取得したのですが更新はどうすればいいですか')?.intent).toBe('RENEW_DOMAIN')
    })

    it('does not steal VIEW_DOMAIN: an acquisition marker alone is not a "what next" question', () => {
      // dataset eval-284 - 「確認」 is deliberately absent from
      // NEXT_STEP_QUESTION_PATTERN for exactly this case.
      expect(classifyIntent('取得したドメインを確認したい')?.intent).toBe('VIEW_DOMAIN')
    })

    it('does not fire on the volitional 「取得したい」 - that is still PURCHASE_DOMAIN', () => {
      expect(classifyIntent('ドメインを取得したいんですけどどうすればいいですか')?.intent).toBe('PURCHASE_DOMAIN')
      expect(hasPostAcquisitionSignal('ドメインを取得したいんですけどどうすればいいですか')).toBe(false)
    })

    it('requires all three parts - the word ドメイン, a past-tense acquisition, and a "what next" question', () => {
      expect(hasPostAcquisitionSignal('ドメインを取得したが公開のために何をすれば良い')).toBe(true)
      // No 「ドメイン」: the false-positive guard against off-topic chatter.
      expect(hasPostAcquisitionSignal('先週買ったばかりなのにどうすればいいですか')).toBe(false)
      // No acquisition marker (dataset eval-357 stays UNKNOWN).
      expect(hasPostAcquisitionSignal('次に何をすればいいですか')).toBe(false)
      expect(classifyIntent('次に何をすればいいですか')).toBeNull()
      // No "what next" question.
      expect(hasPostAcquisitionSignal('ドメインを取得しました')).toBe(false)
    })
  })

  describe('provider aliases beyond brand names', () => {
    it.each([
      ['Gmailを独自ドメインで使いたい', 'google-workspace'],
      ['Outlookを独自ドメインで使いたい', 'microsoft-365'],
      ['M365でメールアドレス作りたいんですけど', 'microsoft-365'],
      ['microsoft365使ってます', 'microsoft-365'],
    ] as const)('%s -> provider %s', (input, providerId) => {
      const result = classifyIntent(input)
      expect(result?.intent).toBe('SETUP_EMAIL')
      expect(result?.slots.provider).toBe(providerId)
    })
  })
})

/**
 * Dataset coverage/correctness suite (team-lead directive): validates
 * `classifyIntent` against the real 500-case corpus `e2e/assistant-eval/
 * dataset.json` (§21.3's LLM-quality dataset) rather than only hand-picked
 * examples. Every regex in `ruleBasedIntent.ts` was tuned against this exact
 * corpus - see the per-matcher comments there for which case drove which
 * ordering/exclusion decision.
 */
interface DatasetCase {
  id: string
  utterance: string
  category: string
  expectedIntent: string
}

const dataset = JSON.parse(rawDataset) as { cases: DatasetCase[] }

const IN_SCOPE_CASES = dataset.cases.filter((c) => c.category === 'in_scope')
const OUT_OF_SCOPE_CASES = dataset.cases.filter((c) => c.category === 'out_of_scope')
const FOLLOW_UP_CASES = dataset.cases.filter((c) => c.category === 'follow_up')
const POST_PURCHASE_CASES = dataset.cases.filter((c) => c.expectedIntent === 'POST_PURCHASE_NEXT_STEPS')
/** `UNKNOWN` is excluded: those cases are the ones that genuinely name no intent at all (eval-336/357). */
const CONCRETE_CLARIFICATION_CASES = dataset.cases.filter(
  (c) => c.category === 'clarification' && c.expectedIntent !== 'UNKNOWN',
)

describe('classifyIntent vs e2e/assistant-eval/dataset.json (quality bar)', () => {
  it(`covers >= 85% of the ${IN_SCOPE_CASES.length} in_scope cases (non-null), and of those, >= 90% match expectedIntent`, () => {
    const results = IN_SCOPE_CASES.map((c) => ({ case: c, guess: classifyIntent(c.utterance) }))
    const nonNull = results.filter((r) => r.guess !== null)
    const correct = nonNull.filter((r) => r.guess!.intent === r.case.expectedIntent)

    const coverage = nonNull.length / IN_SCOPE_CASES.length
    const correctness = correct.length / nonNull.length

    const misclassified = nonNull
      .filter((r) => r.guess!.intent !== r.case.expectedIntent)
      .map((r) => `${r.case.id} "${r.case.utterance}" expected=${r.case.expectedIntent} got=${r.guess!.intent}`)
    const uncovered = results
      .filter((r) => r.guess === null)
      .map((r) => `${r.case.id} "${r.case.utterance}" expected=${r.case.expectedIntent}`)

    // eslint-disable-next-line no-console
    console.log(
      `[ruleBasedIntent dataset eval] coverage=${(coverage * 100).toFixed(1)}% (${nonNull.length}/${IN_SCOPE_CASES.length}), ` +
        `correctness=${(correctness * 100).toFixed(1)}% (${correct.length}/${nonNull.length})\n` +
        `Misclassified (non-null, wrong): ${misclassified.length ? '\n  ' + misclassified.join('\n  ') : '(none)'}\n` +
        `Uncovered (null): ${uncovered.length ? '\n  ' + uncovered.join('\n  ') : '(none)'}`,
    )

    expect(coverage).toBeGreaterThanOrEqual(0.85)
    expect(correctness).toBeGreaterThanOrEqual(0.9)
  })

  it(`resolves ALL ${FOLLOW_UP_CASES.length} follow_up cases - a dead end here is the bug they exist for`, () => {
    // ⚠️ These are the 「さらに見たい」 family: unambiguous only after candidates
    // have been shown. `classifyIntent` is pure and never sees the turn before,
    // so it cannot resolve the referent from context - it resolves them to
    // SEARCH_DOMAIN because that is the overwhelmingly likely meaning in a
    // domain service AND the safe landing (its Playbook asks nothing and offers
    // the candidate search). 100%, not a percentage bar: the reported browser
    // failure was exactly one of these falling through to §11.5's apology, and
    // the whole point of this category is that none of them may do that again.
    const unresolved = FOLLOW_UP_CASES.filter((c) => classifyIntent(c.utterance) === null).map(
      (c) => `${c.id} "${c.utterance}"`,
    )
    expect(unresolved, `Dead-ended:\n  ${unresolved.join('\n  ')}`).toEqual([])

    const wrong = FOLLOW_UP_CASES.filter((c) => classifyIntent(c.utterance)?.intent !== c.expectedIntent).map(
      (c) => `${c.id} "${c.utterance}" -> ${classifyIntent(c.utterance)?.intent}`,
    )
    expect(wrong, `Wrong intent:\n  ${wrong.join('\n  ')}`).toEqual([])
  })

  it(`resolves ALL ${POST_PURCHASE_CASES.length} POST_PURCHASE_NEXT_STEPS cases`, () => {
    // 100%, not a percentage bar, for the same reason `follow_up` above is: the
    // whole point of this intent is that 「取得したけど次に何を？」 must never reach
    // §11.5's apology again. `expectedIntent` is checked too, so a future
    // matcher that claims one of these for a concrete goal it did not name
    // fails here rather than silently changing the answer.
    const wrong = POST_PURCHASE_CASES.filter((c) => classifyIntent(c.utterance)?.intent !== c.expectedIntent).map(
      (c) => `${c.id} "${c.utterance}" -> ${classifyIntent(c.utterance)?.intent ?? 'null'}`,
    )
    expect(wrong, `Wrong intent:\n  ${wrong.join('\n  ')}`).toEqual([])
  })

  it(`never contradicts any of the ${CONCRETE_CLARIFICATION_CASES.length} clarification cases that DO name a concrete intent`, () => {
    // A `clarification` case is one where the app must ask a follow-up before
    // it can propose a screen; `null` is therefore an acceptable rule-based
    // outcome (the model is the primary path). What is never acceptable is
    // confidently answering with a DIFFERENT intent - that is the failure mode
    // the post-acquisition family exhibited, where 「取得した」 was read as
    // VIEW_DOMAIN and answered with the domain list.
    const contradicted = CONCRETE_CLARIFICATION_CASES.map((c) => ({ case: c, guess: classifyIntent(c.utterance) }))
      .filter((r) => r.guess !== null && r.guess.intent !== r.case.expectedIntent)
      .map((r) => `${r.case.id} "${r.case.utterance}" expected=${r.case.expectedIntent} got=${r.guess!.intent}`)
    expect(contradicted, `Contradicted:\n  ${contradicted.join('\n  ')}`).toEqual([])
  })

  it(`never fires an intent for any of the ${OUT_OF_SCOPE_CASES.length} out_of_scope cases (would wrongly route general chat into a Playbook)`, () => {
    const falsePositives = OUT_OF_SCOPE_CASES.map((c) => ({ case: c, guess: classifyIntent(c.utterance) })).filter(
      (r) => r.guess !== null,
    )

    if (falsePositives.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        '[ruleBasedIntent dataset eval] out_of_scope false positives:\n  ' +
          falsePositives.map((r) => `${r.case.id} "${r.case.utterance}" -> ${r.guess!.intent}`).join('\n  '),
      )
    }

    expect(falsePositives).toEqual([])
  })
})
