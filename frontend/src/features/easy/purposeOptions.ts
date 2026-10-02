/**
 * 目的（用途）の選択肢と、目的ごとのフロー定義。
 *
 * 仕様 §6.2.3 の「目的ごとのフロー定義は JSON 等のデータで持つ」に従い、
 * 目的の追加＝この配列に 1 エントリ足すだけで済むようにしてある。
 * ロジックは下の 2 関数（検索と既定 DNS プランの解決）しか持たない。
 */
import { Briefcase, HelpCircle, Mail, PartyPopper, PenLine, ShoppingBag, type LucideIcon } from 'lucide-react'
import type { EasyDnsPlanKind, EasyPurposeKind } from './easyTypes'

export type EasyPurposeOption = {
  kind: EasyPurposeKind
  /** チップに出す表示名（専門用語を使わない）。 */
  label: string
  /**
   * 目的の補足説明。選択肢の 2 行目に出す（§1.4「用語は消さず併記」— ラベルだけ
   * では何を選ぼうとしているのか分からない初心者に、1 行で言い換えを渡す）。
   */
  description: string
  icon: LucideIcon
  /**
   * ドメイン名の候補を作るときの英単語の種。
   * ⚠ 日本語からローマ字は生成しない（読みを推測して綴りを作るのは捏造になる）。
   * ⚠ **いちばん弱い種**。ユーザーが打った名前 → 自由入力から取れた語
   * （noteKeywords.ts の対訳表を含む）→ この一般語、の順に使う。
   * どの目的にも当てはまる語なので、上位の種が取れているときに混ぜてはいけない。
   */
  nameSeeds: readonly string[]
  /** 名前を考えるときのヒントとして画面に例示する語。 */
  nameHints: readonly string[]
  /** この目的なら通常はこれ、という easyDNS の既定プラン。 */
  defaultDnsPlan: EasyDnsPlanKind
}

/**
 * 表示順＝画面の並び順。**先頭 `EASY_PURPOSE_PRIMARY_COUNT` 件だけを最初に見せ**、
 * 残りは「ほかの目的から選ぶ」の中に畳む（初心者に一度に多くを選ばせない）。
 * 並べ替えるときは「よく選ばれる順」を保つこと — 先頭が既定のおすすめになる。
 */
export const EASY_PURPOSE_PRIMARY_COUNT = 3

export const EASY_PURPOSE_OPTIONS: readonly EasyPurposeOption[] = [
  {
    kind: 'business',
    label: '会社やお店のWebサイト',
    description: '会社案内やお店の紹介ページ',
    icon: Briefcase,
    nameSeeds: ['company', 'office', 'studio', 'works'],
    nameHints: ['お店の名前', '会社名の英語表記', '地名＋業種'],
    defaultDnsPlan: 'web',
  },
  {
    kind: 'blog',
    label: '個人ブログ・ポートフォリオ',
    description: '記事や作品をまとめて公開',
    icon: PenLine,
    nameSeeds: ['blog', 'note', 'diary', 'works'],
    nameHints: ['ハンドルネーム', '好きな言葉', '名前＋blog'],
    defaultDnsPlan: 'web',
  },
  {
    kind: 'shop',
    label: 'ECサイト・ネットショップ',
    description: 'ネットで商品を売るお店',
    icon: ShoppingBag,
    nameSeeds: ['shop', 'store', 'market'],
    nameHints: ['ブランド名', '商品ジャンル', '店名＋shop'],
    defaultDnsPlan: 'web',
  },
  {
    kind: 'event',
    label: 'イベント・キャンペーン',
    description: '期間限定のお知らせページ',
    icon: PartyPopper,
    nameSeeds: ['event', 'fes', 'party', 'meetup'],
    nameHints: ['イベント名', '開催年', '会場の地名'],
    defaultDnsPlan: 'web',
  },
  {
    kind: 'mail',
    label: 'メールアドレスとして使う',
    description: '「name@自分のドメイン」でメール',
    icon: Mail,
    nameSeeds: ['mail', 'contact', 'info'],
    nameHints: ['会社名', '名字', 'サービス名'],
    defaultDnsPlan: 'mail',
  },
  {
    kind: 'undecided',
    label: 'まだ決まっていない',
    description: '名前だけ先に確保しておきたいとき',
    icon: HelpCircle,
    nameSeeds: ['my', 'hello', 'good'],
    nameHints: ['自分の名前', '好きな単語', '短い造語'],
    defaultDnsPlan: 'later',
  },
] as const

export function purposeOption(kind: EasyPurposeKind): EasyPurposeOption {
  const found = EASY_PURPOSE_OPTIONS.find((option) => option.kind === kind)
  // EasyPurposeKind と EASY_PURPOSE_OPTIONS は 1:1 なので到達しない。
  if (!found) throw new Error(`unknown easy purpose: ${kind}`)
  return found
}

export function purposeLabel(kind: EasyPurposeKind | null): string {
  return kind ? purposeOption(kind).label : ''
}

/**
 * ステップ6の「何に使うか」の既定値。目的（ステップ1）で既に答えている質問なので、
 * かんたんモードでは二度聞かず、ここで解決した値を選択済みとして見せる。
 * 目的が無いとき（あり得ないが型上はあり得る）は、いちばん無難な web に寄せる。
 */
export function defaultDnsPlanFor(kind: EasyPurposeKind | null): EasyDnsPlanKind {
  return kind ? purposeOption(kind).defaultDnsPlan : 'web'
}
