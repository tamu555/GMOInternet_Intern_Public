/**
 * Route Manifest (spec browser-ai.md §9): the compile-time list of pages the
 * assistant is allowed to navigate a user to. The LLM never sees or produces
 * a URL - it can only pick a `RouteId` from `ALLOWED_ROUTE_IDS`, and the app
 * resolves that id to an internal path via `manifestResolver.ts` (§9.3).
 *
 * `enabled: false` rows stay in the manifest for future pages (§9.2) but are
 * excluded from the AI's choices, from `ALLOWED_ROUTE_IDS`, and from
 * Navigation Cards - flip the flag to `true` once the page ships.
 */

/** §9.2 table, in table order. */
export type RouteId =
  | 'DOMAIN_SEARCH'
  | 'DOMAIN_LIST'
  | 'DOMAIN_DETAIL'
  | 'DNS_RECORDS'
  | 'DNS_NAMESERVER'
  | 'LOGIN'
  | 'SIGNUP'
  | 'LEGAL_LICENSES'
  | 'EASY_MODE'
  | 'DOMAIN_ORDER'
  | 'ORDER_STATUS'
  | 'DNSSEC'
  | 'DOMAIN_TRANSFER'
  | 'ACCOUNT'
  | 'HELP'

/** §9.1 verbatim. */
export interface AssistantRoute {
  id: RouteId
  /** Internal path. May contain ':domainName'. May carry a query string. */
  pathTemplate: string
  title: string
  /** Beginner-friendly copy for the Navigation Card (§13.1). */
  description: string
  /** Sample user utterances, used by the prompt and the eval dataset (§21.3). */
  examples: string[]
  /** Whether the page sits behind <RequireAuth>. */
  requiresAuth: boolean
  /** Whether the pathTemplate needs a ':domainName' substitution. */
  requiresDomain: boolean
  /** false excludes the route from the AI's choices and from the prompt. */
  enabled: boolean
}

export const ASSISTANT_ROUTES: readonly AssistantRoute[] = [
  {
    id: 'DOMAIN_SEARCH',
    pathTemplate: '/',
    title: 'ドメイン検索',
    description: 'ドメインの検索・空き確認・料金の確認や、候補の提案を行える画面です。',
    examples: [
      'ドメインを検索したい',
      '使いたい名前が空いているか確認したい',
      'ドメインの値段を知りたい',
      'どんなドメインがいいか候補がほしい',
    ],
    requiresAuth: false,
    requiresDomain: false,
    enabled: true,
  },
  {
    id: 'DOMAIN_LIST',
    pathTemplate: '/mypage',
    title: '取得済みドメイン一覧',
    description: '取得済みのドメインを一覧で確認できる画面です。',
    examples: ['自分が持っているドメインを見たい', '契約しているドメインの一覧を確認したい', '取得したドメインを管理したい'],
    requiresAuth: true,
    requiresDomain: false,
    enabled: true,
  },
  {
    id: 'DOMAIN_DETAIL',
    pathTemplate: '/mypage/domains/:domainName',
    title: 'ドメイン詳細',
    description:
      'ドメインの期限・更新・自動更新、ネームサーバー変更、ロック、移管、廃止・復旧を確認・操作できる画面です。',
    examples: [
      'このドメインの期限を確認したい',
      'ドメインを更新したい',
      'ドメインを移管したい',
      'ドメインを廃止・復旧したい',
      '自動更新の設定を変えたい',
    ],
    requiresAuth: true,
    requiresDomain: true,
    enabled: true,
  },
  {
    id: 'DNS_RECORDS',
    pathTemplate: '/domains/:domainName/dns?mode=records',
    title: 'DNS設定（レコード設定モード）',
    description:
      'DNSレコード（A・AAAA・CNAME・MX・TXTなど）の確認・変更ができます。レシピからお使いのサービスを選ぶこともできます。',
    examples: [
      'ホームページを公開したい',
      'Vercelでサイトを使いたい',
      'メールを使えるようにしたい',
      'TXTレコードで所有権を確認したい',
      'wwwのサブドメインを作りたい',
    ],
    requiresAuth: true,
    requiresDomain: true,
    enabled: true,
  },
  {
    id: 'DNS_NAMESERVER',
    pathTemplate: '/domains/:domainName/dns?mode=ns',
    title: 'DNS設定（ネームサーバー変更モード）',
    description: 'ネームサーバー（委任先のDNS）を変更できる画面です。',
    examples: ['ネームサーバーを変更したい', 'Cloudflareを使いたい', '他社のDNSに管理を任せたい'],
    requiresAuth: true,
    requiresDomain: true,
    enabled: true,
  },
  {
    id: 'LOGIN',
    pathTemplate: '/login',
    title: 'ログイン',
    description: '登録済みのアカウントでログインする画面です。',
    examples: ['ログインしたい', 'ログイン画面を開きたい', 'アカウントにサインインしたい'],
    requiresAuth: false,
    requiresDomain: false,
    enabled: true,
  },
  {
    id: 'SIGNUP',
    pathTemplate: '/signup',
    title: '新規登録',
    description: '新しくアカウントを作成する画面です。',
    examples: ['新しくアカウントを作りたい', '会員登録をしたい', 'アカウント作成の方法を知りたい'],
    requiresAuth: false,
    requiresDomain: false,
    enabled: true,
  },
  {
    id: 'LEGAL_LICENSES',
    pathTemplate: '/legal/third-party-licenses',
    title: '第三者ライセンス',
    description: 'このサービスが利用しているオープンソースソフトウェアのライセンス情報を確認できる画面です。',
    examples: [
      '使われているソフトウェアのライセンスを見たい',
      'オープンソースの利用表記を確認したい',
      'サードパーティライセンスを見たい',
    ],
    requiresAuth: false,
    requiresDomain: false,
    // §9.2 / §19.2: "✅ true (page implementation happens at the same time)".
    // `pages/ThirdPartyLicensesPage.tsx` and its public `/legal/third-party-licenses`
    // route in AppRouter.tsx now exist, so the row is enabled as the spec
    // requires. `routeManifest.test.ts` proves the path resolves to a real route.
    enabled: true,
  },
  {
    id: 'EASY_MODE',
    pathTemplate: '/easy/goal',
    title: 'かんたんモード',
    description: '初心者向けに、目的から手順を案内する画面です。',
    examples: ['何をすればいいか分からない', 'かんたんモードを使いたい', '簡単な手順で進めたい'],
    requiresAuth: true,
    requiresDomain: false,
    // 🤔 §9.2: still a PlaceholderPage; enable once the easy-mode wizard ships.
    enabled: false,
  },
  {
    id: 'DOMAIN_ORDER',
    pathTemplate: '/domains/new?domain=…',
    title: 'ドメイン申込',
    description: '検索結果から選んだドメインの取得を申し込む画面です。',
    examples: ['このドメインを申し込みたい', 'ドメインを取得する手続きをしたい', '選んだドメインを購入したい'],
    requiresAuth: true,
    requiresDomain: false,
    // 🤔 §9.2: the target domain is decided by the search flow, not by the AI.
    enabled: false,
  },
  {
    id: 'ORDER_STATUS',
    pathTemplate: '/orders/:orderId',
    title: '申込状況',
    description: 'ドメイン取得・更新の申し込み状況を確認する画面です。',
    examples: ['注文の状況を確認したい', '申し込みがどうなっているか知りたい', '支払いが完了したか確認したい'],
    requiresAuth: true,
    requiresDomain: false,
    // 🤔 §9.2: the AI has no way to know a user's orderId.
    enabled: false,
  },
  {
    id: 'DNSSEC',
    // No UI exists yet (only the backend secDNS field) - §9.2.
    pathTemplate: '',
    title: 'DNSSEC設定',
    description: 'DNSSEC（ドメインの署名）を設定する画面です。',
    examples: ['DNSSECを設定したい', 'ドメインの署名を有効にしたい', 'DNSのセキュリティ設定をしたい'],
    requiresAuth: true,
    requiresDomain: true,
    enabled: false,
  },
  {
    id: 'DOMAIN_TRANSFER',
    // No dedicated page exists - the transfer card lives on DOMAIN_DETAIL - §9.2.
    pathTemplate: '',
    title: 'ドメイン移管',
    description: 'ドメインを他社から移す手続きを行う画面です。',
    examples: ['ドメインを他社から移してきたい', '移管の手続きについて知りたい', '認証コード（AuthInfo）について知りたい'],
    requiresAuth: true,
    requiresDomain: true,
    enabled: false,
  },
  {
    id: 'ACCOUNT',
    // No account settings page exists yet - §9.2.
    pathTemplate: '',
    title: 'アカウント設定',
    description: 'アカウントの設定を変更する画面です。',
    examples: ['アカウント設定を変更したい', '登録情報を変更したい', 'パスワードを変更したい'],
    requiresAuth: true,
    requiresDomain: false,
    enabled: false,
  },
  {
    id: 'HELP',
    // No help page exists yet - §9.2.
    pathTemplate: '',
    title: 'ヘルプ',
    description: 'このサービスの使い方について案内する画面です。',
    examples: ['使い方が分からない', 'ヘルプを見たい', '困ったときの相談先を知りたい'],
    requiresAuth: false,
    requiresDomain: false,
    enabled: false,
  },
]

export const ENABLED_ROUTES: readonly AssistantRoute[] = ASSISTANT_ROUTES.filter((route) => route.enabled)

/**
 * Narrows a non-empty array into zod's `z.enum()` tuple shape without an
 * unsound direct cast. Throws only if the source array turns out empty -
 * a coding error in this module, never a runtime/user-input condition.
 */
function asNonEmptyTuple<T>(values: readonly T[]): readonly [T, ...T[]] {
  if (values.length === 0) throw new Error('expected a non-empty array')
  return values as readonly [T, ...T[]]
}

/** Derived from ENABLED_ROUTES, not hand-written (§14.2 "二重定義を作らない"). */
export const ALLOWED_ROUTE_IDS = asNonEmptyTuple(ENABLED_ROUTES.map((route) => route.id))

export function findRoute(id: RouteId): AssistantRoute | undefined {
  return ASSISTANT_ROUTES.find((route) => route.id === id)
}

export function isEnabledRouteId(value: string): value is RouteId {
  return ENABLED_ROUTES.some((route) => route.id === value)
}
