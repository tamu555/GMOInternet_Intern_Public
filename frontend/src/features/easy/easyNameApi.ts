/**
 * ドメイン名の提案アダプター。
 *
 * ┌── モックと本番APIの境界 ────────────────────────────────────────────┐
 * │ 提案 (fetchNameSuggestions)  … ⚠ モック。ブラウザ内のルールベース生成。 │
 * │                                バックエンドに提案APIが存在しないため。   │
 * │ 空き確認 (checkCandidates)   … ✅ 実API。既存の searchDomains を呼ぶ。   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 提案がモックであっても、「空きあり」と表示してよいのは実APIが空きを返した
 * 候補だけです（既存 suggestionEngine.ts と同じ原則 — 生成器の言い分だけで
 * 空きを主張すると、仕様 §6.7 が禁じている「事実でない可用性表示」になる）。
 *
 * TODO(backend): 提案APIが実装されたら `fetchNameSuggestions` の中身だけを
 * `invoke('suggestDomainNames', ...)` に差し替える。呼び出し側と型は変えない。
 */
import { searchDomains, type DomainAvailabilityState } from '../../api/domainsSearchApi'
import { normalizeDomainLabel, validateDomainLabel } from '../domains/validation'
import { japaneseKeywordsFromNote } from './noteKeywords'
import { purposeOption } from './purposeOptions'
import type { EasyNameCandidate, EasyPurposeKind } from './easyTypes'

/** 1 画面に出しすぎないための上限（選択肢を絞る方針）。 */
export const NAME_SUGGESTION_COUNT = 6

export type NameSuggestionInput = {
  purpose: EasyPurposeKind
  /**
   * 目的の自由入力（原文）。ASCII の語をそのまま拾い、日本語は noteKeywords.ts の
   * 対訳表で引く。ここから取れた語は、目的ごとの一般語（nameSeeds）より優先する。
   */
  purposeNote: string
  /** ユーザーが自分で入力しているラベル（あれば最優先の種になる）。 */
  seedLabel?: string
}

/** 自由入力の文章から拾う語の最低文字数。⚠ 本人が打った文字列には掛けない。 */
const HARVESTED_WORD_MIN_LENGTH = 3

/** 自由入力から取り込む語の上限。多いと候補が散らかって選べなくなる。 */
const NOTE_WORD_LIMIT = 3

/**
 * ラベルとして成立するか。判定は検索フォームと同じ §3.4 の規則
 * (`validateDomainLabel`) にそのまま委ねる — 提案側で条件を書き直すと、
 * フォームが受け付ける名前を提案側だけが黙って捨てることになる。
 */
function isLegalLabel(label: string): boolean {
  return validateDomainLabel(label) === undefined
}

/**
 * 文章から機械的に拾った語として使えるか。
 *
 * ⚠ 文字数の下限をここ（＝拾った語）にだけ掛けているのは意図的な非対称。
 * 本人が打った 'g' は本人の意思なので 1 文字でも候補にするが、文章から拾った
 * 1〜2 文字（'a' 'of' など）はほぼノイズなので落とす。この下限を打った文字列に
 * まで掛けていたことが「g と打つと company が出る」不具合の原因だった。
 */
function isHarvestedWord(word: string): boolean {
  return word.length >= HARVESTED_WORD_MIN_LENGTH && isLegalLabel(word)
}

/**
 * URL や定型語として現れるだけで、名前の種にならない ASCII 語。
 *
 * ⚠ 条件欄には URL がそのまま貼られる（「今 https://example.wixsite.com/mybakery
 * で作っているパン屋のページを移したい」）。素朴に拾うと 'https' 'example'
 * 'wixsite' の 3 語で上限が埋まり、その人がいちばん言いたかった「パン屋」が
 * 1 つも通らない。ホスト名の部品まで全部は落とせないので、確実にノイズだと
 * 言い切れるものだけを弾き、残りは下の交互取りで日本語側の枠を確保する。
 */
const NOTE_STOP_WORDS = new Set([
  'http',
  'https',
  'www',
  'com',
  'net',
  'org',
  'jpg',
  'png',
  'html',
  'php',
])

/**
 * 自由入力から ASCII のラベル候補だけを抜き出す。
 * ⚠ 日本語からローマ字は生成しない（読みを推測して綴りを作るのは捏造になる）。
 * 日本語は noteKeywords.ts の手書き対訳表で引く — 表に載っている語しか出さない
 * ので、あちらは捏造にならない。
 */
export function keywordsFromNote(note: string): string[] {
  const normalized = note.normalize('NFKC').toLowerCase()
  const matches = normalized.match(/[a-z][a-z0-9-]{1,}/g) ?? []
  return [...new Set(matches.map((word) => word.replace(/-+$/, '')))]
    .filter((word) => !NOTE_STOP_WORDS.has(word))
    .filter(isHarvestedWord)
}

/**
 * 自由入力から取れる語。ASCII の綴りと対訳表の語を **交互に** 取る。
 *
 * ⚠ 連結してから上限で切ると、ASCII が 3 語ある文（URL やサービス名を書いた人）
 * では日本語側が 1 つも残らない。「くわしい条件を効かせる」のが目的なのに、
 * 日本語で書いた部分だけが押し出されるのは本末転倒なので、どちらの取り口にも
 * 必ず枠が回るように交互に積む。同じ語は先に来たほうを残す。
 * 先頭は ASCII 側 — 本人が自分で綴った語のほうが、表で引いた一般語より本人の
 * 名前に近い。
 */
export function noteWords(note: string): string[] {
  const ascii = keywordsFromNote(note)
  const translated = japaneseKeywordsFromNote(note).filter(isHarvestedWord)

  const interleaved: string[] = []
  for (let index = 0; index < Math.max(ascii.length, translated.length); index += 1) {
    if (index < ascii.length) interleaved.push(ascii[index])
    if (index < translated.length) interleaved.push(translated[index])
  }
  return [...new Set(interleaved)].slice(0, NOTE_WORD_LIMIT)
}

function traitsOf(label: string, affixes: readonly string[]): string[] {
  const traits: string[] = []
  if (label.length <= 8) traits.push('短くて覚えやすい')
  if (!label.includes('-')) traits.push('入力しやすい')
  else traits.push('区切りがあって読みやすい')
  if (affixes.some((affix) => label.includes(affix))) traits.push('用途が伝わる')
  return traits
}

const REASON_BY_PURPOSE: Record<EasyPurposeKind, string> = {
  business: 'お店や会社の名前がそのまま伝わる形にしました。',
  blog: '自分の名前や好きな言葉を活かした形にしました。',
  shop: 'お店だと一目で分かる形にしました。',
  event: 'イベント名が短く伝わる形にしました。',
  mail: 'メールアドレスにしたときに読みやすい形にしました。',
  undecided: 'あとからどんな使い方にも合う、短くて素直な形にしました。',
}

/**
 * ⚠ モックの生成本体。決定的（同じ入力から常に同じ並び）で、乱数も時刻も使わない。
 * デモの再現性と、テストの安定のために意図的にそうしている。
 *
 * 並びの規則（上から順に埋め、`NAME_SUGGESTION_COUNT` で打ち切る）:
 *   ① 打った名前そのもの（1 文字でも、ラベルとして成立するなら必ず先頭）
 *   ② 打った名前 ＋ 自由入力から取れた語
 *   ③ 打った名前 ＋ 目的の一般語（nameSeeds）
 *   ④ 自由入力から取れた語（打った名前が無いときだけ）
 *   ⑤ 目的の一般語のフォールバック（種が何も取れなかったときだけ）
 */
export function generateNameCandidates(input: NameSuggestionInput): EasyNameCandidate[] {
  const option = purposeOption(input.purpose)
  const seeds = option.nameSeeds
  const words = noteWords(input.purposeNote)
  const typed = normalizeDomainLabel(input.seedLabel ?? '').toLowerCase()

  const generated: string[] = []
  const push = (label: string) => {
    if (isLegalLabel(label) && !generated.includes(label)) generated.push(label)
  }
  const combine = (base: string, affixes: readonly string[]) => {
    for (const affix of affixes) {
      if (affix === base) continue
      push(`${base}${affix}`)
      push(`${base}-${affix}`)
    }
  }

  if (isLegalLabel(typed)) {
    push(typed) // ①
    combine(typed, words) // ②
    combine(typed, seeds) // ③
    /* ⚠ ここで打ち切る。打った名前が有るのに無関係な語を並べる（'g' と打った人に
       'company' を出す）のが今回の不具合そのもので、④⑤へ落ちてはいけない。
       組み合わせが上限に届かなければ、少ないまま返すほうが正しい。 */
    return toCandidates(generated, input.purpose, [...words, ...seeds])
  }

  // ④ 条件から取れた語は、まず語そのものを全部出してから組み合わせに移る
  //    （1 語目の組み合わせだけで上限に達して、2 語目が消えるのを避ける）。
  for (const word of words) push(word)
  for (const word of words) combine(word, seeds)
  if (generated.length === 0) {
    // ⑤ 種が 1 つも無い場合でも空にしない（空状態は「入力を促す」で別途扱う）。
    for (const seed of seeds.filter(isHarvestedWord).slice(0, 2)) {
      push(seed)
      combine(seed, seeds)
    }
  }
  for (const seed of seeds) push(`my-${seed}`)

  return toCandidates(generated, input.purpose, [...words, ...seeds])
}

function toCandidates(
  labels: readonly string[],
  purpose: EasyPurposeKind,
  affixes: readonly string[],
): EasyNameCandidate[] {
  return labels.slice(0, NAME_SUGGESTION_COUNT).map((label) => ({
    label,
    reason: REASON_BY_PURPOSE[purpose],
    traits: traitsOf(label, affixes),
  }))
}

/**
 * ⚠ モック。提案APIが無いため、ブラウザ内で決定的に生成する。
 * Promise を返す形にしてあるのは、本番APIへ差し替えたときに呼び出し側を
 * まったく変えずに済むようにするため。
 */
export function fetchNameSuggestions(input: NameSuggestionInput): Promise<EasyNameCandidate[]> {
  return Promise.resolve(generateNameCandidates(input))
}

export type LabelAvailability = {
  label: string
  state: DomainAvailabilityState
  /** 空きが確認できた TLD のうち、いちばん優先度が高いもの（表示用）。 */
  availableTlds: string[]
}

/**
 * ✅ 実API。候補ラベルの空き状況を、代表 TLD 群に対してまとめて確認する。
 *
 * 1 ラベルにつき 1 回の `searchDomains` 呼び出し。呼び出しが失敗したラベルは
 * 'unknown'（＝確認できなかった）にする。'taken' には落とさない — 通信失敗を
 * 使用中と表示するのは仕様 §6.7 が明確に禁じている。
 */
export async function checkCandidates(
  labels: readonly string[],
  tlds: readonly string[],
  signal?: AbortSignal,
): Promise<LabelAvailability[]> {
  const probeTlds = tlds.slice(0, 5)
  if (probeTlds.length === 0) {
    return labels.map((label) => ({ label, state: 'unknown' as const, availableTlds: [] }))
  }

  return Promise.all(
    labels.map(async (label): Promise<LabelAvailability> => {
      try {
        const response = await searchDomains({ label, tlds: [...probeTlds] }, signal)
        const availableTlds = response.results
          .filter((result) => result.state === 'available')
          .map((result) => result.tld)
        if (availableTlds.length > 0) return { label, state: 'available', availableTlds }
        const allTaken = response.results.every((result) => result.state === 'taken')
        if (allTaken) return { label, state: 'taken', availableTlds: [] }
        // 全滅の理由が「接続不能と判定済み」または「告知されたメンテナンス中」
        // なら「？」に丸めず伝える（§6.9 / registry-unavailable.md）。
        const allSettled = response.results.every(
          (result) =>
            result.state === 'unavailable' ||
            result.state === 'maintenance' ||
            result.state === 'taken',
        )
        if (!allSettled) return { label, state: 'unknown', availableTlds: [] }
        const anyMaintenance = response.results.some((result) => result.state === 'maintenance')
        return { label, state: anyMaintenance ? 'maintenance' : 'unavailable', availableTlds: [] }
      } catch {
        return { label, state: 'unknown', availableTlds: [] }
      }
    }),
  )
}
