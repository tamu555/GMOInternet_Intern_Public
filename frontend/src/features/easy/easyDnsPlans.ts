/**
 * easyDNS 設定（ステップ6）のデータ定義。
 *
 * 「サービスを選ぶだけで設定内容が決まる」ためのデータ層。レコードの実体は
 * 既存の `features/dns/recipes.ts`（レシピ方式 §6.3.3b）をそのまま再利用し、
 * ここでは「かんたんモードでどれをどの順で見せるか」だけを持つ。
 * サービスの追加＝recipes.ts への JSON 追加 ＋ 下の配列への id 追加。
 */
import { DNS_RECIPES, applyRecipe, type DnsRecipe } from '../dns/recipes'
import type { DnsRecord } from '../dns/dnsRecordTypes'
import type { EasyDnsPlanKind } from './easyTypes'

export type EasyDnsPlanOption = {
  kind: EasyDnsPlanKind
  label: string
  description: string
  /** この使いみちで出すサービスの絞り込み（recipes.ts の category）。 */
  categories: readonly ('web' | 'mail')[]
}

export const EASY_DNS_PLAN_OPTIONS: readonly EasyDnsPlanOption[] = [
  {
    kind: 'web',
    label: 'Webサイトに接続する',
    description: '作ったサイトを、このドメインで見られるようにします。',
    categories: ['web'],
  },
  {
    kind: 'mail',
    label: 'メールに使用する',
    description: '「name@このドメイン」でメールを送受信できるようにします。',
    categories: ['mail'],
  },
  {
    kind: 'both',
    label: 'Webサイトとメールの両方に使用する',
    description: 'サイトの公開とメールの受信を、まとめて設定します。',
    categories: ['web', 'mail'],
  },
  {
    /**
     * 画面の選択肢としては出さない（使いみちは目的から自動で決まるため）。
     * 古い下書きに残っている値をラベルへ解決するためだけに残してある。
     */
    kind: 'recommended',
    label: 'よく分からないのでおすすめ設定を使う',
    description: 'まずはサイトを公開できる、いちばん標準的な設定にします。',
    categories: ['web'],
  },
  {
    kind: 'later',
    label: 'あとで設定する',
    description: 'ドメインの取得だけ先に済ませます。設定はマイページからいつでもできます。',
    categories: [],
  },
] as const

export function dnsPlanOption(kind: EasyDnsPlanKind): EasyDnsPlanOption {
  const found = EASY_DNS_PLAN_OPTIONS.find((option) => option.kind === kind)
  // EasyDnsPlanKind と EASY_DNS_PLAN_OPTIONS は 1:1 なので到達しない。
  if (!found) throw new Error(`unknown easy dns plan: ${kind}`)
  return found
}

export function dnsPlanLabel(kind: EasyDnsPlanKind | null): string {
  return kind ? dnsPlanOption(kind).label : '取得したあとに決める'
}

/**
 * かんたんモードで見せるサービスの並び（ユーザーに馴染みのある順）。
 *
 * DNS_RECIPES の全件をここに載せる。かんたんモードだけ選択肢が少ないと、
 * 一覧に無いサービスを使う初心者が袋小路に入る（通常モードの方が手厚い、
 * という逆転が起きる）。ns-guide のレシピ（Cloudflare・エックスサーバー）も
 * 出すが、レコード保存ではなく NS 変更モードへの案内につながる。
 */
const EASY_SERVICE_ORDER: readonly string[] = [
  'vercel',
  'netlify',
  'github-pages',
  'shopify',
  'sakura-rental',
  'xserver',
  'cloudflare',
  'custom-server',
  'google-workspace',
  'microsoft-365',
]

/**
 * 「一覧にない／案内文がある」を選んだときの擬似サービス ID (§6.3.3c)。
 * DnsRecipe ではないので serviceById は undefined を返す — 貼り付けパーサで
 * 作ったレコードをそのまま保存対象にする分岐の目印として使う。
 */
export const EASY_PASTE_SERVICE_ID = 'paste'

/**
 * 「サイトやメールをまだ用意していない」を選んだときの擬似サービス ID。
 * DnsRecipe ではないので serviceById は undefined を返す。レコードは 1 件も
 * 作らないので、この選択のあいだは保存ボタン自体を出さない（§6.3.3e と同じ
 * 理由: 空配列の保存は「全部消す」保存になる）。
 */
export const EASY_NO_TARGET_SERVICE_ID = 'not-yet'

/** 選んだ使いみちに合うサービス一覧（表示順つき）。 */
export function servicesForPlan(kind: EasyDnsPlanKind): DnsRecipe[] {
  const { categories } = dnsPlanOption(kind)
  if (categories.length === 0) return []
  return EASY_SERVICE_ORDER.map((id) => DNS_RECIPES.find((recipe) => recipe.id === id))
    .filter((recipe): recipe is DnsRecipe => recipe !== undefined)
    .filter((recipe) => categories.includes(recipe.category))
}

export function serviceById(id: string): DnsRecipe | undefined {
  return DNS_RECIPES.find((recipe) => recipe.id === id)
}

/** そのサービスで入力がまだ埋まっていない項目のキー。 */
export function missingRecipeInputs(recipe: DnsRecipe, inputs: Record<string, string>): string[] {
  return (recipe.inputs ?? []).filter((input) => !inputs[input.key]?.trim()).map((input) => input.key)
}

/**
 * 「詳細を見る」で開くレコードのプレビュー。入力が未完なら null を返す
 * （applyRecipe は未入力で throw する防御ガードなので、その手前で止める）。
 *
 * ⚠️ 'ns-guide' のレシピも null を返す（空配列ではない）。saveDnsRecords は
 * 全置換セマンティクスなので、空配列で保存すると「レコードを全部消す」保存が
 * 成功扱いになってしまう。呼び出し側は null を「保存してはいけない」と読む。
 */
export function previewRecords(recipe: DnsRecipe, inputs: Record<string, string>): DnsRecord[] | null {
  if (recipe.mode !== 'records') return null
  if (missingRecipeInputs(recipe, inputs).length > 0) return null
  return applyRecipe(recipe, inputs)
}

/** レコード種別を初心者向けに言い換える（専門用語は残したうえで注釈する §1.4）。 */
export const RECORD_TYPE_PLAIN_LABEL: Record<string, string> = {
  A: 'サイトの置き場所（Aレコード）',
  AAAA: 'サイトの置き場所・新しい方式（AAAAレコード）',
  CNAME: '別名の転送先（CNAMEレコード）',
  MX: 'メールの届け先（MXレコード）',
  TXT: '所有者であることの証明など（TXTレコード）',
  NS: '管理を任せる先（NSレコード）',
}

export function plainRecordLabel(type: string): string {
  return RECORD_TYPE_PLAIN_LABEL[type] ?? type
}
