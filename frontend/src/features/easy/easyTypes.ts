/**
 * かんたんモード（初心者向けウィザード）のデータモデル。
 *
 * 設計の中心は「意図」と「事実」を分けること (仕様 §6.2.3)。
 * `EasySession` が保持するのはユーザーがまだ入力している最中の *意図* だけで、
 * 「支払えた」「取得できた」といった *事実* は一切載せない。事実はバックエンド
 * （`getOrder` / `getDomainInfo`）が真実を持っているので、その都度問い合わせる。
 * ボタンを押した事実を完了フラグとして保存すると、ブラウザを閉じた瞬間に嘘に
 * なる（§6.2.3 が明示的に禁じている）。
 *
 * 「完了済みステップ」も同じ理由で保存しない。`completedStepsOf()` が
 * セッションの中身から導出する（入力が揃っている＝完了）。
 */
import type { DnsRecordType } from '../dns/dnsRecordTypes'
import { CONNECT_TERM } from './easyJourney'

/** 目的の選択肢。表示文言は purposeOptions.ts にデータとして持つ。 */
export type EasyPurposeKind = 'business' | 'blog' | 'shop' | 'event' | 'mail' | 'undecided'

/** ウィザードのステップ。URL からも現在地が分かるよう 1 ステップ 1 ルート。 */
export type EasyStepId = 'goal' | 'name' | 'tld' | 'confirm' | 'payment' | 'dns'

/** easyDNS 設定でユーザーが選ぶ「何に使うか」。 */
export type EasyDnsPlanKind = 'web' | 'mail' | 'both' | 'later' | 'recommended'

/** TLD 候補の並べ替え軸（§6.2.4 の比較軸）。 */
/** 一覧の並び替えの軸。⚠️ 「おすすめ」はここに戻さない — 目的順は利用者が選ぶ軸ではなく、
 *  画面上部のおすすめ帯が常に持つ独立した並び（purposeTldPriority.rankByPurpose）。 */
export type EasyTldFilter = 'price' | 'japan' | 'business'

export type EasyStepDef = {
  id: EasyStepId
  /**
   * 進行バーに出す短いラベル。**2〜4文字**に保つ — 6 段すべてが 1 行に並ぶのが
   * この表示の価値で、長い語を入れると折り返して「いま何番目か」が読めなくなる。
   * そのステップが何をする画面かは、各ページの見出しが引き受ける。
   */
  label: string
  /**
   * 初心者向けの1〜2行の説明。
   *
   * ⚠️ **現時点でこの文字列を描いている画面は 1 つも無い**（2026-08-28 時点）。
   * 唯一 EASY_STEPS を進捗表示へ渡す EasyStepper は ProgressSteps に渡すだけで、
   * ProgressSteps の props は `ProgressStep = { id, label }` — `hint` は落ちる。
   * リポジトリ内で `step.hint` を読むコードは存在しない（`.hint` の grep 一致は
   * EasyTldPage の絞り込みチップという別物だけ）。つまりここは**書いてあるだけで
   * 利用者に届いていない**ので、「この説明はもう出してある」を前提に別の画面から
   * 説明を省かないこと。
   *
   * 描くならどこか、は未決。候補としてはステップ 6 の画面のリード文（`EasyDnsPage`
   * の `EasyPageHeader` は `lede` を受け取れるが、通常フェーズでは渡していない）が
   * 有力だが、そこで確定というわけではない。ステップの説明をどの画面が引き受けるかは
   * 進捗表示まわり（EasyStepper / EasyJourneyMap）と合わせて決めること。
   *
   * 文言の基準: `label` が言えない「このステップが、サイト公開のどこに効くのか」を
   * ここが引き受ける。ゴールは「ドメインを取ること」ではなく
   * 「取ったドメインでサイトが見られること」（進捗バー到達点の
   * EASY_GOAL_STEP_LABEL「公開完了」）なので、その文脈で読んで正しい文だけを置く。
   */
  hint: string
  path: string
  /** true のステップから先はログインが必要（AppRouter の RequireAuth と対応）。 */
  requiresAuth: boolean
}

/**
 * ステップ定義。追加・並べ替えはこの配列だけで完結する
 * （ステッパー・ガード・「戻る/次へ」がすべてここを読む）。
 *
 * ⚠️ 6 段そろっても「サイト公開」には届かない。サイトの中身の置き場所
 * （easyJourney.ts の `place`）は当サービスでは用意できず、利用者が別の
 * サービスで契約するものだからである。`hint` に「これで公開できます」と
 * 読める文を書かないこと。
 */
export const EASY_STEPS: readonly EasyStepDef[] = [
  { id: 'goal', label: '目的', hint: 'どんなことに使うドメインかを教えてください。おすすめの名前と末尾が、この答えで変わります。', path: '/easy/goal', requiresAuth: false },
  { id: 'name', label: '名前', hint: 'ドメインの「名前」の部分を決めます。空き状況をその場で確認します。', path: '/easy/name', requiresAuth: false },
  { id: 'tld', label: '末尾', hint: '.com や .site など、名前のうしろに付く部分を選びます。', path: '/easy/tld', requiresAuth: false },
  { id: 'confirm', label: '確認', hint: '取得する内容と料金をまとめて確認します。直したいところは、ここから前の画面に戻れます。', path: '/easy/confirm', requiresAuth: true },
  { id: 'payment', label: 'お支払い', hint: 'お支払いが済むと、このドメインはあなたのものになります（疑似決済なので実際の請求は発生しません）。', path: '/easy/payment', requiresAuth: true },
  /* ⚠️ CONNECT_TERM を直書きに戻さないこと（呼び方が 2 つあると、また別物だと
     読まれる）。ただしこの hint 自体はまだどこにも描かれていないので、
     「つなぐ設定＝DNS設定」を利用者に届けているのはこの行ではない（実際に
     届けているのは easyJourney.ts の CONNECT_TERM を出す画面のほう）。 */
  { id: 'dns', label: 'つなぐ', hint: `${CONNECT_TERM}で、取ったドメインを、サイトやメールの置き場所に結びつけます。これをしないと、ドメインを打っても何も表示されません。`, path: '/easy/dns', requiresAuth: true },
] as const

/**
 * ステップ 2 の検索結果（/easy/name/results）。
 *
 * ⚠️ EASY_STEPS には足さない。ステッパー上はあくまで 2/6「名前」の続きで、
 * 進捗が 1 段増えたように見せてはならない。「1 ステップ 1 ルート」の唯一の
 * 例外がここで、検索フォームと検索結果を別ルートに分けているのは、押した瞬間に
 * 画面が切り替わること自体が「検索が実行された」という手応えになるため
 * （フォームの下に候補が生えてくる形だと、どこを見ればいいのかが分からない）。
 */
export const EASY_NAME_RESULTS_PATH = '/easy/name/results'

/** 完了画面。ステッパーには出さない（全ステップ完了後の到達点）。 */
export const EASY_DONE_PATH = '/easy/done'

export function easyStepDef(step: EasyStepId): EasyStepDef {
  const found = EASY_STEPS.find((entry) => entry.id === step)
  // EasyStepId は EASY_STEPS の id と 1:1 なので到達しない。
  if (!found) throw new Error(`unknown easy step: ${step}`)
  return found
}

export function easyStepIndex(step: EasyStepId): number {
  return EASY_STEPS.findIndex((entry) => entry.id === step)
}

/** 「お気に入り」や候補一覧で使う 1 件のドメイン候補。 */
export type EasyNameCandidate = {
  /** TLD を含まないラベル（例 'my-bakery'）。 */
  label: string
  /** 提案理由（1行）。 */
  reason: string
  /** 覚えやすさなどの特徴タグ（例 '短い' '読みやすい'）。 */
  traits: string[]
}

/**
 * ウィザードの保存対象。**意図だけ**。
 *
 * localStorage に載るため、機微情報は入れない（authInfo は毎回その場で生成し
 * 永続化しない — SignupProvider がパスワードを除外しているのと同じ方針）。
 */
export type EasySession = {
  /** 1. 目的 */
  purpose: EasyPurposeKind | null
  /** 1. 目的の自由入力（原文のまま保持し、提案の種にする）。 */
  purposeNote: string
  /** 2. 提案されたドメイン候補（再表示のために保持）。 */
  candidates: EasyNameCandidate[]
  /** 2. お気に入りに入れたラベル。 */
  favorites: string[]
  /** 2. 選択したドメイン名（正規化済みラベル、TLD を含まない）。 */
  label: string
  /** 3. 選択した TLD（先頭ドットつき、例 '.com'）。未選択は ''。 */
  tld: string
  /** 4. 契約期間（年）。 */
  years: number
  /** 4. オプション（現時点で実在するのは自動更新のみ）。 */
  autoRenew: boolean
  /** 4/6. DNS 設定方法。確認画面で先に決め、6 で具体化する。 */
  dnsPlan: EasyDnsPlanKind | null
  /** 6. 選んだサービス（dns/recipes.ts の DnsRecipe.id）。 */
  dnsServiceId: string | null
  /** 6. サービス固有の入力（レシピの {placeholder} を埋める値）。 */
  dnsInputs: Record<string, string>
  /** 5. createOrder が返した注文 ID。未発行は null。 */
  orderId: string | null
  /** 5. 注文したドメイン（FQDN）。未確定は ''。 */
  domainName: string
  /** 最終更新の ISO 8601。古い下書きの判別用。 */
  updatedAt: string
}

export const EMPTY_EASY_SESSION: EasySession = {
  purpose: null,
  purposeNote: '',
  candidates: [],
  favorites: [],
  label: '',
  tld: '',
  years: 1,
  autoRenew: true,
  dnsPlan: null,
  dnsServiceId: null,
  dnsInputs: {},
  orderId: null,
  domainName: '',
  updatedAt: '',
}

/**
 * そのステップを開いてよいか（前提となる入力が揃っているか）。
 *
 * 「完了しているか」とは別物なので分けてある。たとえば支払い画面は、
 * 注文がまだ無い状態（＝未完了）でこそ開ける必要がある。
 */
export function isEasyStepAllowed(session: EasySession, step: EasyStepId): boolean {
  switch (step) {
    case 'goal':
      return true
    case 'name':
      return session.purpose !== null
    case 'tld':
      return session.label.length > 0
    case 'confirm':
    case 'payment':
      return session.label.length > 0 && session.tld.length > 0
    case 'dns':
      return session.orderId !== null
  }
}

/**
 * そのステップの成果物が存在するか（＝完了しているか）。
 *
 * 「ユーザーがボタンを押した」ではなく、その手前で作られた実データで判定する。
 * 確認・支払いの完了はどちらも「注文が発行された」ことで、注文の発行は
 * バックエンドの createOrder が返した事実である（仕様 §6.2.3）。
 */
export function isEasyStepCompleted(session: EasySession, step: EasyStepId): boolean {
  switch (step) {
    case 'goal':
      return session.purpose !== null
    case 'name':
      return session.label.length > 0
    case 'tld':
      return session.tld.length > 0
    case 'confirm':
    case 'payment':
      return session.orderId !== null
    case 'dns':
      return session.dnsPlan !== null
  }
}

/** 完了済みステップの一覧（保存せず、毎回セッションから導出する）。 */
export function completedStepsOf(session: EasySession): EasyStepId[] {
  return EASY_STEPS.filter((step) => isEasyStepCompleted(session, step.id)).map((step) => step.id)
}

/**
 * いま開くべきステップ。前提を満たしている範囲で最も先の、まだ完了していない
 * ステップを返す。未入力のまま後続ステップへ直接来た場合の差し戻し先になる。
 */
export function furthestReachableStep(session: EasySession): EasyStepId {
  let result: EasyStepId = EASY_STEPS[0].id
  for (const step of EASY_STEPS) {
    if (!isEasyStepAllowed(session, step.id)) break
    result = step.id
    if (!isEasyStepCompleted(session, step.id)) break
  }
  return result
}

/** ステッパーのリンクを踏めるか（＝そのステップを開いてよいか）。 */
export function canEnterEasyStep(session: EasySession, step: EasyStepId): boolean {
  return isEasyStepAllowed(session, step)
}

/** ステップ 6 で書き込むレコード種別（進捗と説明文の両方が読む）。 */
export const DNS_PLAN_RECORD_TYPES: Record<EasyDnsPlanKind, readonly DnsRecordType[]> = {
  web: ['A', 'CNAME'],
  mail: ['MX', 'TXT'],
  both: ['A', 'CNAME', 'MX', 'TXT'],
  recommended: ['A', 'CNAME'],
  later: [],
}
