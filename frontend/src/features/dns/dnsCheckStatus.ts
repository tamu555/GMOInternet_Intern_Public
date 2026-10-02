/**
 * 「確認する」ボタンの5状態判定 (spec §6.3.3d)。
 *
 * ⚠️ OK / NG の2値にしてはならない — 登録直後は必ず引けないため、赤いエラーに
 * すると初心者は「壊れた」と思って設定をいじり回して本当に壊す。「反映待ち」
 * を正常系として必ず持つ。
 *
 * ⚠️ この確認が調べられるのは「当サービスのDNSに登録されているか」だけである。
 * レコードは実DNSへ配信されない（§6.3.1-6.3.2 のレベル2 = 自前のミニリゾルバ。
 * functions/src/domain/dnsZones.ts が保存先そのものを引き直している）ので、
 * ✓ を「世界から見えている」と読ませてはならない。世界から見えるかどうかは、
 * このドメインをどのネームサーバーに委任しているか（レジストリの状態）で
 * 決まる別の軸なので、判定にはその委任状態を必ず渡す。
 */
import type { DnsRecord } from './dnsRecordTypes'

/**
 * レジストリから見た委任先。当サービスは実ネームサーバーを持たない（仕様
 * v0.3.4 で申込フォームの既定NSを廃止）ため、委任先は「未設定」か「外部」の
 * 2つしかない。
 */
export type DnsDelegation = 'none' | 'external'

export type DnsCheckState = 'unset' | 'notPublished' | 'pending' | 'ok' | 'mismatch'

export type DnsCheckOutcome = {
  state: DnsCheckState
  expected: DnsRecord[]
  actual: DnsRecord[]
}

/**
 * §3.5 の status から委任状態を求める。`inactive` = ネームサーバー未設定
 * （マイページの「まだインターネットに公開されていません」と同じ根拠）。
 */
export function delegationFromStatuses(statuses: readonly string[]): DnsDelegation {
  return statuses.includes('inactive') ? 'none' : 'external'
}

/** 比較キー: 大文字小文字と末尾ドットの違いは一致とみなす。 */
function valueKey(record: DnsRecord): string {
  return record.value.trim().replace(/\.$/, '').toLowerCase()
}

function matches(expected: DnsRecord, actual: DnsRecord): boolean {
  if (expected.type !== actual.type) return false
  if (valueKey(expected) !== valueKey(actual)) return false
  // MX は優先度もセットで一致して初めて「つながっている」。
  if (expected.type === 'MX' && expected.priority !== actual.priority) return false
  return true
}

/**
 * expected = 保存済みのレコード（この名前・種別のぶん）、actual = resolveDns の
 * 応答。判定は保存済みレコードを正として「全件が応答に含まれるか」を見る。
 *
 * 委任が未設定のときは応答を見ない。当サービスのDNSに保存できていても、
 * レジストリが誰にも委任していない以上そのレコードは誰にも届かないので、
 * ✓ を出すと「✓ なのにサイトが見えない」という嘘になる（マイページの
 * 「まだインターネットに公開されていません」と食い違う）。
 */
export function judgeDnsCheck(
  expected: DnsRecord[],
  actual: DnsRecord[],
  delegation: DnsDelegation,
): DnsCheckOutcome {
  if (expected.length === 0) return { state: 'unset', expected, actual }
  if (delegation === 'none') return { state: 'notPublished', expected, actual }
  if (actual.length === 0) return { state: 'pending', expected, actual }
  const allFound = expected.every((record) => actual.some((candidate) => matches(record, candidate)))
  return { state: allFound ? 'ok' : 'mismatch', expected, actual }
}

/**
 * 表示文言 (§6.3.3d の表)。
 *
 * ⚠️ `ok` の説明は「つながっています ✓」から書き換えてある。当サービスのDNSは
 * 実DNSへ配信しないので、旧文言は確認できていないことを断言していた。
 */
export const DNS_CHECK_LABELS: Record<DnsCheckState, { label: string; description: string }> = {
  unset: { label: '未設定', description: 'まだ設定していません' },
  notPublished: {
    label: '未公開',
    description: 'ネームサーバーが未設定のため、まだインターネットに公開されていません',
  },
  pending: {
    label: '反映待ち',
    description: '設定は保存されました。反映まで通常数分〜最大48時間かかります',
  },
  ok: { label: '確認できた', description: '当サービスのDNSに登録されています ✓' },
  mismatch: { label: '値が違う', description: '期待値と実際の値が異なります' },
}
