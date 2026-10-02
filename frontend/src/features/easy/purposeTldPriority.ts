/**
 * 目的 → TLD（ドメインの末尾）の優先度表と、比較の軸（§6.2.4）。
 *
 * ⚠ プレースホルダのデータです。仕様には目的→TLD優先度表そのものが無く（§6.2.4
 * は方針だけを決めている）、下の並びは「一般的な認知度」を根拠にした仮置きです。
 * 料金 (tldData.ts) と同じく、確定したらこのファイルのデータを差し替えるだけで
 * 画面側は変更不要です。
 *
 * ⚠ ここに書ける TLD は `TLD_METADATA` に実在する 22 件だけ。取り扱いのない TLD
 * を並べると `createOrder` が「このTLDは取り扱っていません」で弾く画面を作って
 * しまうため、`purposeTldPriority.test.ts` が全件の実在を検証しています。
 * 日本の ccTLD（.jp）は現時点で両レジストリとも取り扱いがないため、
 * 「日本向け」軸は「日本で認知度の高い汎用TLD」を優先する定義にしています。
 */
import { getTldPricing, TLD_METADATA } from '../domains/tldData'
import type { EasyPurposeKind, EasyTldFilter } from './easyTypes'

/** 目的ごとの優先順（上位ほどおすすめ）。表に無い TLD は GENERAL_TLD_ORDER で後ろに並ぶ。 */
export const PURPOSE_TLD_PRIORITY: Record<EasyPurposeKind, readonly string[]> = {
  business: ['.com', '.net', '.info', '.site', '.website', '.org', '.build', '.ceo'],
  blog: ['.site', '.website', '.art', '.fun', '.space', '.xyz', '.online', '.com'],
  shop: ['.store', '.online', '.site', '.com', '.website', '.fun', '.net'],
  event: ['.fun', '.space', '.site', '.online', '.xyz', '.com', '.press'],
  mail: ['.com', '.net', '.org', '.info', '.site', '.online'],
  undecided: ['.com', '.net', '.site', '.online', '.xyz', '.info'],
}

/** 目的ごとの「なぜこの末尾が選ばれているのか」の 1 行。表に無い TLD は汎用文。 */
const PURPOSE_TLD_REASON: Record<EasyPurposeKind, string> = {
  business: '会社やお店のサイトでよく使われていて、初めての人にも信用されやすい末尾です。',
  blog: '個人サイトや作品置き場でよく使われていて、名前を自由に付けやすい末尾です。',
  shop: 'ネットショップで使われることが多く、お店だと一目で伝わる末尾です。',
  event: '期間限定のページで使われることが多く、短くて覚えてもらいやすい末尾です。',
  mail: '受け取る側にも見慣れていて、メールアドレスにしたときに違和感が少ない末尾です。',
  undecided: 'いろいろな使い方に合う、いちばん無難な末尾です。',
}

/** TLD ごとの「向いている使い方」。プレースホルダ（TBD）。 */
const TLD_FIT: Record<string, string> = {
  '.com': '会社・お店・個人、どれにも合う定番',
  '.net': 'サービスや技術系のサイト',
  '.org': '団体・コミュニティ・非営利の活動',
  '.info': 'お知らせや案内が中心のサイト',
  '.xyz': '短く安く始めたいとき',
  '.online': 'ネット上のサービス全般',
  '.site': 'まずはサイトを 1 つ持ちたいとき',
  '.tech': '技術・ものづくり系の発信',
  '.space': '個人の実験場・作品置き場',
  '.store': 'ネットショップ',
  '.website': '会社案内などの説明サイト',
  '.press': 'ニュース・お知らせの発信',
  '.host': 'サーバーやホスティング関連',
  '.fun': 'イベントや趣味のページ',
  '.icu': 'とにかく安く始めたいとき',
  '.cyou': 'とにかく安く始めたいとき',
  '.sbs': '小規模なサービス紹介',
  '.bond': 'コミュニティやつながりの紹介',
  '.cfd': '短い名前を安く確保したいとき',
  '.art': '作品・ポートフォリオ',
  '.build': '建築・ものづくり・制作',
  '.ceo': '経営者・代表者の個人サイト',
}

/** 「日本向け」軸で優先する TLD（.jp の取り扱いが無いための代替定義）。 */
const JAPAN_FRIENDLY_TLDS: readonly string[] = ['.com', '.net', '.info', '.org', '.site', '.online']

/** 「企業向け」軸で優先する TLD。 */
const BUSINESS_TLDS: readonly string[] = ['.com', '.net', '.org', '.info', '.ceo', '.build', '.website']

/**
 * 「ほかに取得できる末尾」の並び替えの軸。
 *
 * ⚠️ 「おすすめ」の軸は 2026-08-28 に外した。目的に合うおすすめは画面のいちばん上に
 * 3 件のカードとして**常時**出ているので、同じ並びを一覧側の選択肢としても
 * 出すと、押しても上と同じものが出てくるだけのボタンになる。
 * おすすめ帯の並びは利用者の選んだ軸に影響されず、つねに {@link rankByPurpose}。
 */
export const EASY_TLD_FILTERS: readonly { id: EasyTldFilter; label: string; hint: string }[] = [
  { id: 'price', label: '価格を重視', hint: '初年度の料金が安い順に並べます。' },
  { id: 'japan', label: '日本向け', hint: '日本で見慣れている末尾を先に出します。' },
  { id: 'business', label: '企業向け', hint: '会社やお店で使われることが多い末尾を先に出します。' },
] as const

export function fitForTld(tld: string): string {
  return TLD_FIT[tld] ?? 'いろいろな使い方に合います'
}

export function reasonForPurposeTld(purpose: EasyPurposeKind, tld: string): string {
  const priority = PURPOSE_TLD_PRIORITY[purpose]
  return priority.includes(tld)
    ? PURPOSE_TLD_REASON[purpose]
    : 'この名前で取得できる末尾のひとつです。'
}

function rankIndex(order: readonly string[], tld: string): number {
  const index = order.indexOf(tld)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

/**
 * 「おすすめ」の最後の拠り所（2026-08-28 追加）。
 *
 * ⚠️ これが無いと、優先度表に載っていない末尾どうしは元の並び順のまま残る。
 * その「元の並び」は検索APIが返した順＝`functions/src/api/listTlds.ts` の
 * `Object.keys(map).sort()`、つまり **アルファベット順** なので、22件のうち
 * 表に載っている 6〜8 件を除いた残り全部が `.art .bond .build .cfd .cyou …`
 * と並び、「おすすめ順なのにアルファベット順」に見えていた。
 *
 * `TLD_METADATA` の並びは認知度の高い順に手で並べてあるので（.com .net .org
 * .info → kitaqnic の18件）、それをそのまま一般的なおすすめ度として使う。
 * 表に載っている末尾は先に order で決着が付くため、ここは効かない。
 */
const GENERAL_TLD_ORDER: readonly string[] = TLD_METADATA.map((meta) => meta.tld)

/** 同順位の最後の分け方: 初年度が安いほうを上に出す（未設定は最後）。 */
function firstYearOf(tld: string): number {
  return getTldPricing(tld)?.firstYearYen ?? Number.MAX_SAFE_INTEGER
}

/**
 * 優先表で決着が付かなかった 2 件を分ける、共通の後段。
 * 一般的な認知度 → 初年度の安さ → 元の並び、の順に見る。
 */
function breakTie(a: { tld: string; index: number }, b: { tld: string; index: number }): number {
  const generalA = rankIndex(GENERAL_TLD_ORDER, a.tld)
  const generalB = rankIndex(GENERAL_TLD_ORDER, b.tld)
  if (generalA !== generalB) return generalA - generalB

  const priceA = firstYearOf(a.tld)
  const priceB = firstYearOf(b.tld)
  if (priceA !== priceB) return priceA - priceB
  return a.index - b.index
}

function withIndex(tlds: readonly string[]): { tld: string; index: number }[] {
  return tlds.map((tld, index) => ({ tld, index }))
}

/**
 * **目的に合う順**（＝おすすめ順）に並べ替えた新しい配列を返す。
 *
 * 画面のいちばん上に出す「目的に合うおすすめ 3 件」はここだけで決まり、利用者が
 * 選んだ並び替えの軸には影響されない — おすすめ帯が軸で入れ替わると、上の 3 枚が
 * 「おすすめ」を名乗ったまま中身だけ別物になる。
 */
export function rankByPurpose(tlds: readonly string[], purpose: EasyPurposeKind): string[] {
  const order = PURPOSE_TLD_PRIORITY[purpose]
  const entries = withIndex(tlds)
  entries.sort((a, b) => {
    const rankA = rankIndex(order, a.tld)
    const rankB = rankIndex(order, b.tld)
    if (rankA !== rankB) return rankA - rankB
    return breakTie(a, b)
  })
  return entries.map((entry) => entry.tld)
}

/**
 * 一覧側の並び替え。{@link EASY_TLD_FILTERS} の軸に沿って並べ替えた新しい配列を
 * 返す（元配列は変更しない）。同順位は上の breakTie で決める。
 *
 * ⚠️ 目的（おすすめ）はここでは扱わない。おすすめは {@link rankByPurpose} が
 * 持つ独立した並びで、利用者が選ぶ軸ではない。
 */
export function rankTlds(tlds: readonly string[], filter: EasyTldFilter): string[] {
  const entries = withIndex(tlds)

  entries.sort((a, b) => {
    if (filter === 'price') {
      const priceA = firstYearOf(a.tld)
      const priceB = firstYearOf(b.tld)
      if (priceA !== priceB) return priceA - priceB
      return a.index - b.index
    }

    const order = filter === 'japan' ? JAPAN_FRIENDLY_TLDS : BUSINESS_TLDS
    const rankA = rankIndex(order, a.tld)
    const rankB = rankIndex(order, b.tld)
    if (rankA !== rankB) return rankA - rankB
    return breakTie(a, b)
  })

  return entries.map((entry) => entry.tld)
}

/** テスト用: 表に並ぶ TLD がすべて実在することを検証するための一覧。 */
export const ALL_PRIORITY_TLDS: readonly string[] = [
  ...new Set([
    ...Object.values(PURPOSE_TLD_PRIORITY).flat(),
    ...JAPAN_FRIENDLY_TLDS,
    ...BUSINESS_TLDS,
    ...Object.keys(TLD_FIT),
  ]),
]

/** テスト用: 実在する TLD の集合。 */
export const KNOWN_TLDS: ReadonlySet<string> = new Set(TLD_METADATA.map((meta) => meta.tld))
