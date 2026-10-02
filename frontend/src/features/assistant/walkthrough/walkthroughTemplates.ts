/**
 * Guided Walkthrough step templates (`.agents/docs/research/assistant-walkthrough-plan.md`
 * §2-§3, spec browser-ai.md §7.6/§34). Everything here is a compile-time
 * constant: the LLM only ever supplies an `IntentId` (unchanged from today -
 * §11.1), and that intent is looked up against this table to pick a
 * `WalkthroughTemplate`. Not one character of a step's `label`/`title`/
 * `description`/`warnings` is written or chosen by the model - this is the
 * same "LLM cannot say 'done'" invariant as §8.2, extended to the whole
 * walkthrough (FR-21 - see `walkthroughState.ts`).
 *
 * Persona (plan §1.1): 佐藤悠, 19 years old, has never touched DNS before.
 * Every description is written for that reader - no unexplained jargon, and
 * (§8.2/FR-16) never a DNS record VALUE. A step whose completion can only be
 * observed on an external service's own dashboard (checking a value, running
 * that service's own verification) is honestly modelled as `{ kind: 'manual' }`
 * - the app truly cannot see it happen.
 */
import { DNS_RECIPES } from '../../dns/recipes'
import type { DocTopic } from '../docs/docSources'
import type { IntentId } from '../routing/playbooks'
import type { RouteId } from '../routing/routeManifest'

/**
 * How a step's completion is observed (FR-21): either the app itself saw the
 * user land on `routeId` (`AssistantLauncher` records every route visit, even
 * while the walkthrough modal is closed - see `walkthroughState.ts`), or the
 * user ticked a manual checkbox because the work happened somewhere the app
 * cannot see (an external service's dashboard).
 */
export type StepCompletion = { kind: 'visited-route'; routeId: RouteId } | { kind: 'manual' }

/**
 * The button a step may render. Deliberately its own small union rather than
 * reusing `AssistantActionKind` (`actions.ts`, owned by another wave this
 * phase) - `SET_SLOT` has no meaning inside a walkthrough step, and `NAVIGATE`
 * (routing, not a Quick Action at all) does not exist in that union. Built
 * entirely by the app from a `RouteId`/`DocTopic` already known at compile
 * time - never from model output.
 */
export interface WalkthroughStepAction {
  kind: 'NAVIGATE' | 'SUGGEST_DOMAINS' | 'OPEN_DOC' | 'RUN_WEB_SEARCH'
  /** Required when `kind === 'NAVIGATE'`. */
  routeId?: RouteId
  /** Required when `kind === 'OPEN_DOC'`. */
  docTopic?: DocTopic
}

export interface WalkthroughStep {
  id: string
  /** Short label for the progress bar/stepper. */
  label: string
  /** Title for the in-message card. */
  title: string
  /** Beginner-friendly explanation of what to do and why. */
  description: string
  completion: StepCompletion
  /** The button that advances this step, if any. */
  action?: WalkthroughStepAction
  warnings?: string[]
}

/**
 * One id per `.agents/docs/research/assistant-walkthrough-plan.md` §3 table
 * row - except the "PURCHASE_DOMAIN / SEARCH_DOMAIN" row and the "ADD_A_RECORD
 * ほか5種" row, which each cover more than one `IntentId` and so expand into
 * more than one id below (see the module-level report for the exact count:
 * 11 table rows, 16 template objects).
 */
export type WalkthroughId =
  | 'PURCHASE_DOMAIN'
  | 'SEARCH_DOMAIN'
  | 'CONNECT_WEBSITE'
  | 'SETUP_EMAIL'
  | 'CHANGE_NAMESERVER'
  | 'VERIFY_DOMAIN'
  | 'CREATE_SUBDOMAIN'
  | 'ADD_A_RECORD'
  | 'ADD_AAAA_RECORD'
  | 'ADD_CNAME'
  | 'ADD_TXT'
  | 'ADD_MX'
  | 'RENEW_DOMAIN'
  | 'RETIRE_DOMAIN'
  | 'TRANSFER_DOMAIN'
  | 'TROUBLESHOOT_DNS'

export interface WalkthroughTemplate {
  id: WalkthroughId
  intent: IntentId
  title: string
  /** 3-6 steps (plan §8 risk note: too few is not guidance, too many is clutter). */
  steps: WalkthroughStep[]
}

/**
 * §9.2: the DNS trio is real (functions/src/api/dnsRecords.ts) but the
 * rental DNS is a store-backed mini resolver (§6.3.2 Lv2) that never
 * publishes to the real internet DNS, so no template may promise that a save
 * propagates - reused verbatim from `routing/playbooks.ts`'s private
 * `DNS_STUB_WARNING` (not exported from there, so restated here rather than
 * imported across a file this wave does not own).
 */
const DNS_STUB_NOTE = 'DNS設定の保存はまだ検証中の機能です。反映を保証する案内はしません。'

/** §8.2/FR-16: the AI (and this template) never supplies a DNS record value. */
const NO_DNS_VALUE_NOTE = 'DNSレコードの値はAIが決めません。表示されている値をそのまま確認してください。'

/**
 * `docs/registrar-spec-draft.md` §6.3.3(a)'s mandatory NS-change warning
 * ("このサービスで設定したレコードは無効になります。メールも止まります"),
 * restated in the phrasing `routing/playbooks.ts`'s `NAMESERVER_CHANGE_WARNING`
 * already uses for the same requirement (not exported from there, so
 * duplicated as a compile-time string here rather than imported across a file
 * this wave does not own) - both call out the same two consequences: DNS
 * records stop applying, and mail stops working.
 */
const NAMESERVER_CHANGE_WARNING =
  'ネームサーバーを変更すると、このサービスで設定したDNSレコードは使われなくなります。メールも止まります。'

/**
 * The services this app actually has a recipe for, read from `DNS_RECIPES` -
 * never hand-listed.
 *
 * ⚠️ Both "choose a service" steps used to carry a hand-written excerpt
 * (「Vercel / Netlify / GitHub Pages / Cloudflare など」) that named 4 of the 8
 * `category: 'web'` recipes. That is the same drift 決定40(b) removed from the
 * Playbook slot question, reappearing one file over: a user who publishes on
 * さくらのレンタルサーバ or Shopify read a list their service was missing from and
 * had no way to know a recipe existed for it. Generating the list means it
 * cannot go stale when `recipes.ts` gains an entry - the 「新サービスの追加＝JSON
 * 追加のみ」 principle that file is built on.
 *
 * Naming only what has a recipe is also the honest scope: these are the services
 * the app can fill in automatically, NOT a recommendation or a ranking, and the
 * step copy says in the next breath that anything else still works by hand.
 */
function webOrMailRecipes(category: 'web' | 'mail') {
  return DNS_RECIPES.filter((recipe) => recipe.category === category)
}

function recipeServiceNames(category: 'web' | 'mail'): string {
  return webOrMailRecipes(category)
    .map((recipe) => recipe.service)
    .join(' / ')
}

function recipeServiceCount(category: 'web' | 'mail'): number {
  return webOrMailRecipes(category).length
}

/**
 * `docs/registrar-spec-draft.md` §6.3.3 also requires the same warning at
 * domain retirement time ("このドメインを使っているWebサイトとメールが止まり
 * ます").
 */
const RETIRE_DOMAIN_WARNING = 'このドメインを廃止すると、このドメインを使っているWebサイトとメールが止まります。'

/**
 * Row 1 of the plan's §3 table: `PURCHASE_DOMAIN` and `SEARCH_DOMAIN` share
 * one walkthrough shape (a factory, same precedent as `routing/playbooks.ts`'s
 * `addRecordPlaybook` below) so the two copies of "ドメインを取得する" cannot
 * drift apart. `DOMAIN_ORDER` stays unreferenced (§9.2: disabled) - the
 * "申し込む" step routes back through `DOMAIN_SEARCH`, per the plan's explicit
 * instruction.
 */
function buildDomainAcquisitionTemplate(id: 'PURCHASE_DOMAIN' | 'SEARCH_DOMAIN'): WalkthroughTemplate {
  const prefix = id.toLowerCase().replace(/_/g, '-')
  return {
    id,
    intent: id,
    title: 'ドメインを取得する',
    steps: [
      {
        id: `${prefix}-decide-name`,
        label: '名前を決める',
        title: 'ほしいドメイン名を決める',
        description:
          'お店やサービスの名前など、ドメインにしたい文字列を考えます。日本語ではなく英数字（ローマ字）にすると、次の検索がしやすくなります。',
        completion: { kind: 'manual' },
      },
      {
        id: `${prefix}-search`,
        label: '空きを確認する',
        title: 'ドメインの空き状況を確認する',
        description:
          'ドメイン検索画面で考えた名前を入力すると、その名前がすでに使われていないか（空いているか）と、取得にかかる料金がわかります。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_SEARCH' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_SEARCH' },
      },
      {
        id: `${prefix}-apply`,
        label: '申し込む',
        title: 'ドメインの取得を申し込む',
        description:
          '検索結果の候補一覧から、気に入った名前を選んで申し込み手続きに進みましょう。申し込みが完了したかはこの画面からは自動でわからないので、手続きが終わったらチェックを入れてください。',
        completion: { kind: 'manual' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_SEARCH' },
      },
      {
        id: `${prefix}-confirm`,
        label: '取得を確認する',
        title: '取得したドメインを確認する',
        description: 'マイページの一覧に、取得したドメインが表示されていれば完了です。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_LIST' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_LIST' },
      },
    ],
  }
}

/**
 * Row 7: the five `ADD_*_RECORD` intents (`routing/playbooks.ts §10.2`: A /
 * AAAA / CNAME / TXT / MX - `NS` has no `ADD_*` intent of its own, only
 * `CHANGE_NAMESERVER`) share one shape, exactly like `playbooks.ts`'s
 * `addRecordPlaybook` factory, so the five templates cannot drift apart.
 */
function buildAddRecordTemplate(
  intent: 'ADD_A_RECORD' | 'ADD_AAAA_RECORD' | 'ADD_CNAME' | 'ADD_TXT' | 'ADD_MX',
  recordLabel: string,
): WalkthroughTemplate {
  const prefix = intent.toLowerCase().replace(/_/g, '-')
  return {
    id: intent,
    intent,
    title: `${recordLabel}を追加する`,
    steps: [
      {
        id: `${prefix}-open`,
        label: 'DNS設定を開く',
        title: 'DNS設定を開く',
        description: 'DNS設定のレコード設定モードを開きます。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
      },
      {
        id: `${prefix}-check-value`,
        label: '値を確認する',
        title: '設定する値を確認する',
        description: `追加する${recordLabel}の値（接続先を示す文字列）は、接続先のサービスの管理画面に表示されています。値はサービスによって異なるため、ここでは案内できません。表示されている値をそのまま確認してください。`,
        completion: { kind: 'manual' },
        warnings: [NO_DNS_VALUE_NOTE],
      },
      {
        id: `${prefix}-add`,
        label: '追加する',
        title: `${recordLabel}を追加する`,
        description: `確認した値を使って、レコード設定画面から${recordLabel}を追加しましょう。`,
        completion: { kind: 'manual' },
      },
      {
        id: `${prefix}-verify`,
        label: '反映を確認する',
        title: '反映を確認する',
        description:
          '設定はすぐには反映されないことがあります。数分から最大48時間ほどかかることがあるため、DNS設定画面の「確認する」機能で状態を確認してください。',
        completion: { kind: 'manual' },
        warnings: [DNS_STUB_NOTE],
      },
    ],
  }
}

export const WALKTHROUGH_TEMPLATES: readonly WalkthroughTemplate[] = [
  buildDomainAcquisitionTemplate('PURCHASE_DOMAIN'),
  buildDomainAcquisitionTemplate('SEARCH_DOMAIN'),
  {
    id: 'CONNECT_WEBSITE',
    intent: 'CONNECT_WEBSITE',
    title: 'Webサイトを公開する',
    steps: [
      {
        id: 'connect-website-have-domain',
        label: 'ドメインを用意する',
        title: 'ドメインを用意する',
        description: '公開に使うドメインを取得済みか、マイページの一覧で確認しましょう。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_LIST' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_LIST' },
      },
      {
        id: 'connect-website-choose-provider',
        label: '公開先サービスを選ぶ',
        title: '公開先サービスを選ぶ',
        description:
          'ここで決めるのは「サイトのファイルを置く場所」です。ドメインが住所だとすると、公開先サービスは建物にあたり、別々に用意します。' +
          'すでにサイトを公開しているなら、そのサービスがそのまま公開先です。まだサイト自体を作っていない場合は先にそちらが必要で、それはこのサービスでは行えません。' +
          `このサービスが設定を自動で入れる「レシピ」を用意しているのは次の${recipeServiceCount('web')}つです: ${recipeServiceNames('web')}。` +
          'ここに無いサービスでも、次の手順で確認する接続情報を手で入力すれば設定できます。',
        completion: { kind: 'manual' },
      },
      {
        id: 'connect-website-check-value',
        label: '設定値を確認する',
        title: 'サービス側で設定値を確認する',
        description:
          '選んだサービスの管理画面に、このドメインをつなぐための接続情報が表示されます。値はサービスによって異なるため、ここでは案内できません。サービス側の画面で確認してください。',
        completion: { kind: 'manual' },
        action: { kind: 'OPEN_DOC', docTopic: 'custom-domain' },
      },
      {
        id: 'connect-website-set-dns',
        label: 'DNSレコードを設定する',
        title: 'DNSレコードを設定する',
        description:
          'DNS設定のレコード設定モードを開き、「レシピ」から選んだサービスを選ぶと、必要なレコードが自動で入ります。表示された値は書き換えず、確認だけしてください。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
        warnings: [DNS_STUB_NOTE],
      },
      {
        id: 'connect-website-verify',
        label: '反映を確認する',
        title: '反映を確認する',
        description:
          '設定はすぐには反映されないことがあります（数分〜最大48時間）。DNS設定画面の「確認する」機能で、つながっているか確認してください。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'SETUP_EMAIL',
    intent: 'SETUP_EMAIL',
    title: 'メールを使えるようにする',
    steps: [
      {
        id: 'setup-email-have-domain',
        label: 'ドメインを用意する',
        title: 'ドメインを用意する',
        description: 'メールに使うドメインを取得済みか、マイページの一覧で確認しましょう。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_LIST' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_LIST' },
      },
      {
        id: 'setup-email-choose-provider',
        label: 'メールサービスを選ぶ',
        title: 'メールサービスを選ぶ',
        description:
          'ここで決めるのは「メールを実際に送受信するサービス」です。ドメインを取得しただけではメールは使えず、メールボックスを持つサービスと組み合わせます。' +
          `このサービスがレシピを用意しているのは次の${recipeServiceCount('mail')}つです: ${recipeServiceNames('mail')}。` +
          'いずれも各サービス側での契約が別途必要です。ここに無いサービスでも、次の手順で確認するMXの値を手で入力すれば設定できます。',
        completion: { kind: 'manual' },
      },
      {
        id: 'setup-email-check-value',
        label: '設定値を確認する',
        title: '管理画面で設定値を確認する',
        description:
          '選んだサービスの管理画面に、メール受信用の接続情報（MX の値）が表示されます。値はサービスによって異なるため、ここでは案内できません。サービス側の画面で確認してください。',
        completion: { kind: 'manual' },
        action: { kind: 'OPEN_DOC', docTopic: 'email' },
      },
      {
        id: 'setup-email-set-dns',
        label: 'MXレコードを設定する',
        title: 'MXレコードを設定する',
        description:
          'DNS設定のレコード設定モードを開き、「レシピ」から選んだメールサービスを選ぶと、必要なレコードが自動で入ります。表示された値は書き換えず、確認だけしてください。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
        warnings: [DNS_STUB_NOTE],
      },
      {
        id: 'setup-email-verify',
        label: '受信を確認する',
        title: '受信を確認する',
        description:
          '設定はすぐには反映されないことがあります（数分〜最大48時間）。反映を待ってから、実際にメールが届くか確認してください。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'CHANGE_NAMESERVER',
    intent: 'CHANGE_NAMESERVER',
    title: 'ネームサーバーを変更する',
    steps: [
      {
        id: 'change-nameserver-understand-impact',
        label: '影響を理解する',
        title: '変更前に影響を理解する',
        description:
          'ネームサーバー（「このドメインの設定はどこで管理するか」を指し示す情報）を変更すると、DNSの管理そのものが移行先に移ります。以下の注意点を必ず確認してください。',
        completion: { kind: 'manual' },
        warnings: [NAMESERVER_CHANGE_WARNING],
      },
      {
        id: 'change-nameserver-check-target',
        label: '移行先のNSを確認する',
        title: '移行先のネームサーバーを確認する',
        description:
          '移行先のサービス（Cloudflareなど）の管理画面に表示されているネームサーバーの値を確認しましょう。値はサービスによって異なるため、ここでは案内できません。',
        completion: { kind: 'manual' },
        action: { kind: 'OPEN_DOC', docTopic: 'nameserver' },
      },
      {
        id: 'change-nameserver-set',
        label: 'NS変更モードで設定する',
        title: 'NS変更モードで設定する',
        description: 'DNS設定のネームサーバー変更モードを開き、確認した値を入力して変更します。',
        completion: { kind: 'visited-route', routeId: 'DNS_NAMESERVER' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_NAMESERVER' },
        warnings: [DNS_STUB_NOTE],
      },
      {
        id: 'change-nameserver-verify',
        label: '反映を確認する',
        title: '反映を確認する',
        description:
          'ネームサーバーの変更は反映まで時間がかかることがあります（数分〜最大48時間）。移行先のサービス側の案内に従って反映を確認してください。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'VERIFY_DOMAIN',
    intent: 'VERIFY_DOMAIN',
    title: '所有権確認（TXT）を通す',
    steps: [
      {
        id: 'verify-domain-issue-value',
        label: 'TXT値を発行する',
        title: '確認元でTXT値を発行する',
        description:
          '所有権を確認したいサービス（GitHub Pagesなど）の管理画面で、確認用のTXTレコードの値を発行してもらいます。値はサービスによって異なるため、ここでは案内できません。',
        completion: { kind: 'manual' },
        action: { kind: 'OPEN_DOC', docTopic: 'verification' },
      },
      {
        id: 'verify-domain-add-txt',
        label: 'TXTレコードを追加する',
        title: 'TXTレコードを追加する',
        description:
          'DNS設定のレコード設定モードにある「貼り付けて読み取る」機能に発行された案内文を貼り付けると、TXTレコードの下書きを作成できます。内容を確認して保存しましょう。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
        warnings: [NO_DNS_VALUE_NOTE, DNS_STUB_NOTE],
      },
      {
        id: 'verify-domain-run-check',
        label: 'サービス側で確認を実行する',
        title: 'サービス側で確認を実行する',
        description: '確認元のサービスの管理画面に戻り、「確認する」操作を実行してもらいます。',
        completion: { kind: 'manual' },
      },
      {
        id: 'verify-domain-done',
        label: '完了',
        title: '完了を確認する',
        description: 'サービス側の管理画面で「確認できました」と表示されたら完了です。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'CREATE_SUBDOMAIN',
    intent: 'CREATE_SUBDOMAIN',
    title: 'サブドメインを作る',
    steps: [
      {
        id: 'create-subdomain-decide-purpose',
        label: '用途を決める',
        title: '用途を決める',
        description:
          'サブドメイン（独自ドメインの前に付ける「www」のような部分）を何に使うか決めます。用途によって追加するレコードの種類が変わります。',
        completion: { kind: 'manual' },
      },
      {
        id: 'create-subdomain-open-dns',
        label: 'レコード設定画面へ',
        title: 'レコード設定画面を開く',
        description: 'DNS設定のレコード設定モードを開きます。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
      },
      {
        id: 'create-subdomain-add-record',
        label: 'レコードを追加する',
        title: 'レコードを追加する',
        description:
          '決めたサブドメイン名で、必要なレコードを追加しましょう。値は接続先のサービスの案内に従ってください。',
        completion: { kind: 'manual' },
        warnings: [NO_DNS_VALUE_NOTE],
      },
      {
        id: 'create-subdomain-verify',
        label: '反映を確認する',
        title: '反映を確認する',
        description:
          '設定はすぐには反映されないことがあります。DNS設定画面の「確認する」機能で状態を確認してください。',
        completion: { kind: 'manual' },
        warnings: [DNS_STUB_NOTE],
      },
    ],
  },
  buildAddRecordTemplate('ADD_A_RECORD', 'Aレコード'),
  buildAddRecordTemplate('ADD_AAAA_RECORD', 'AAAAレコード'),
  buildAddRecordTemplate('ADD_CNAME', 'CNAMEレコード'),
  buildAddRecordTemplate('ADD_TXT', 'TXTレコード'),
  buildAddRecordTemplate('ADD_MX', 'MXレコード'),
  {
    id: 'RENEW_DOMAIN',
    intent: 'RENEW_DOMAIN',
    title: '期限を延ばす',
    steps: [
      {
        id: 'renew-domain-check-expiry',
        label: '期限を確認する',
        title: '有効期限を確認する',
        description: 'ドメイン詳細画面で、このドメインの有効期限を確認します。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_DETAIL' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_DETAIL' },
      },
      {
        id: 'renew-domain-renew',
        label: '更新する',
        title: '更新の手続きをする',
        description: 'ドメイン詳細画面の更新ボタンから、有効期限を延ばす手続きをします。',
        completion: { kind: 'manual' },
      },
      {
        id: 'renew-domain-verify',
        label: '反映を確認する',
        title: '反映を確認する',
        description: 'ドメイン詳細画面を開き直して、有効期限が延びていることを確認しましょう。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'RETIRE_DOMAIN',
    intent: 'RETIRE_DOMAIN',
    title: 'もう使わないドメインを整理する',
    steps: [
      {
        id: 'retire-domain-understand-impact',
        label: '影響を理解する',
        title: '廃止する前に影響を理解する',
        description: 'ドメインを廃止する前に、以下の注意点を必ず確認してください。',
        completion: { kind: 'manual' },
        warnings: [RETIRE_DOMAIN_WARNING],
      },
      {
        id: 'retire-domain-retire',
        label: '廃止する',
        title: '廃止の手続きをする',
        description: 'ドメイン詳細画面の廃止ボタンから、手続きを進めます。復旧できる期間があるかも合わせて確認しましょう。',
        completion: { kind: 'manual' },
      },
      {
        id: 'retire-domain-verify',
        label: '状態を確認する',
        title: '状態を確認する',
        description: 'ドメイン詳細画面で、ドメインの状態が「廃止」になっていることを確認します。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_DETAIL' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_DETAIL' },
      },
    ],
  },
  {
    id: 'TRANSFER_DOMAIN',
    intent: 'TRANSFER_DOMAIN',
    title: '移管する',
    steps: [
      {
        id: 'transfer-domain-unlock',
        label: 'ロックを解除する',
        title: '移管ロックを解除する',
        description:
          'ドメイン詳細画面で、移管を防ぐためのロックがかかっていないか確認し、かかっていれば解除します。',
        completion: { kind: 'manual' },
      },
      {
        id: 'transfer-domain-authinfo',
        label: 'AuthInfoを取得する',
        title: '認証コード（AuthInfo）を取得する',
        description: 'ドメイン詳細画面の移管カードから、移管に必要な認証コード（AuthInfo）を確認します。',
        completion: { kind: 'visited-route', routeId: 'DOMAIN_DETAIL' },
        action: { kind: 'NAVIGATE', routeId: 'DOMAIN_DETAIL' },
      },
      {
        id: 'transfer-domain-apply',
        label: '移管先で申請する',
        title: '移管先のサービスで申請する',
        description: '移管先のサービスの管理画面で、取得した認証コードを使って移管を申請します。',
        completion: { kind: 'manual' },
      },
      {
        id: 'transfer-domain-verify',
        label: '完了を確認する',
        title: '移管の完了を確認する',
        description: '移管先のサービスの管理画面で、移管が完了したことを確認しましょう。',
        completion: { kind: 'manual' },
      },
    ],
  },
  {
    id: 'TROUBLESHOOT_DNS',
    intent: 'TROUBLESHOOT_DNS',
    title: '反映されないときに確認する',
    steps: [
      {
        id: 'troubleshoot-dns-review',
        label: '設定内容を見直す',
        title: '設定内容を見直す',
        description: 'DNS設定のレコード設定モードを開き、追加したレコードの内容に誤りがないか見直します。',
        completion: { kind: 'visited-route', routeId: 'DNS_RECORDS' },
        action: { kind: 'NAVIGATE', routeId: 'DNS_RECORDS' },
      },
      {
        id: 'troubleshoot-dns-check',
        label: 'DNSチェックで確認する',
        title: 'DNSチェックで確認する',
        description: 'DNS設定画面の「確認する」機能で、設定した内容が反映されているか確認します。',
        completion: { kind: 'manual' },
        warnings: [DNS_STUB_NOTE],
      },
      {
        id: 'troubleshoot-dns-ttl',
        label: 'TTLの待ち時間を理解する',
        title: 'TTL（反映にかかる時間の目安）を理解する',
        description:
          'DNSの設定は保存してすぐには反映されないことがあります。TTL（Time To Live、情報が使い回される時間の目安）の分だけ、最大48時間ほど待つ必要がある場合があります。',
        completion: { kind: 'manual' },
        action: { kind: 'OPEN_DOC', docTopic: 'glossary' },
      },
    ],
  },
]

export function findWalkthroughTemplate(id: WalkthroughId): WalkthroughTemplate | undefined {
  return WALKTHROUGH_TEMPLATES.find((template) => template.id === id)
}

export function templateForIntent(intent: IntentId): WalkthroughTemplate | undefined {
  return WALKTHROUGH_TEMPLATES.find((template) => template.intent === intent)
}

export function hasWalkthroughForIntent(intent: IntentId): boolean {
  return templateForIntent(intent) !== undefined
}
