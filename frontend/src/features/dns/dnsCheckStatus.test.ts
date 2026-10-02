import { describe, expect, it } from 'vitest'
import type { DnsRecord } from './dnsRecordTypes'
import { DNS_CHECK_LABELS, delegationFromStatuses, judgeDnsCheck } from './dnsCheckStatus'

const SAVED_A: DnsRecord = { type: 'A', name: '@', value: '76.76.21.21' }

describe('judgeDnsCheck — the five states (§6.3.3d, never a binary OK/NG)', () => {
  it('is "unset" when nothing is saved', () => {
    expect(judgeDnsCheck([], [], 'external').state).toBe('unset')
    // 応答に何かあっても保存が無ければ未設定（判定の主語は保存済みレコード）。
    expect(judgeDnsCheck([], [SAVED_A], 'external').state).toBe('unset')
    // 未委任でも「まだ何も設定していない」が先に来る（そちらが直す順序）。
    expect(judgeDnsCheck([], [], 'none').state).toBe('unset')
  })

  it('is "pending" (not an error) when saved but the resolver returns nothing', () => {
    expect(judgeDnsCheck([SAVED_A], [], 'external').state).toBe('pending')
  })

  it('is "ok" when every saved record appears in the answer', () => {
    expect(judgeDnsCheck([SAVED_A], [SAVED_A], 'external').state).toBe('ok')
  })

  it('matches case-insensitively and ignores a trailing dot', () => {
    const saved: DnsRecord = { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }
    const answered: DnsRecord = { type: 'CNAME', name: 'www', value: 'CNAME.Vercel-DNS.com.' }
    expect(judgeDnsCheck([saved], [answered], 'external').state).toBe('ok')
  })

  it('is "mismatch" when a value differs', () => {
    const answered: DnsRecord = { type: 'A', name: '@', value: '203.0.113.99' }
    expect(judgeDnsCheck([SAVED_A], [answered], 'external').state).toBe('mismatch')
  })

  it('requires the MX priority to match too', () => {
    const saved: DnsRecord = { type: 'MX', name: '@', value: 'smtp.google.com', priority: 1 }
    const wrongPriority: DnsRecord = { ...saved, priority: 10 }
    expect(judgeDnsCheck([saved], [wrongPriority], 'external').state).toBe('mismatch')
    expect(judgeDnsCheck([saved], [saved], 'external').state).toBe('ok')
  })

  it('is "ok" only when ALL saved records are found (partial answer = mismatch)', () => {
    const second: DnsRecord = { type: 'A', name: '@', value: '185.199.108.153' }
    expect(judgeDnsCheck([SAVED_A, second], [SAVED_A], 'external').state).toBe('mismatch')
  })

  it('carries expected/actual through for the diff display', () => {
    const outcome = judgeDnsCheck([SAVED_A], [], 'external')
    expect(outcome.expected).toEqual([SAVED_A])
    expect(outcome.actual).toEqual([])
  })

  /**
   * ⚠️ 回帰の本体: 委任が無いドメインで ✓ を出してはならない。当サービスのDNSは
   * 引ければ必ず一致を返す（保存先を引き直しているだけ）ので、委任を見ないと
   * 「✓ なのにサイトが見えない」＋マイページとの矛盾が必ず起きる。
   */
  it('never answers "ok" while the domain is not delegated (inactive)', () => {
    expect(judgeDnsCheck([SAVED_A], [SAVED_A], 'none').state).toBe('notPublished')
    expect(judgeDnsCheck([SAVED_A], [], 'none').state).toBe('notPublished')
    // 応答が食い違っていても、先に伝えるべきは「公開されていない」ほう。
    const answered: DnsRecord = { type: 'A', name: '@', value: '203.0.113.99' }
    expect(judgeDnsCheck([SAVED_A], [answered], 'none').state).toBe('notPublished')
  })
})

describe('delegationFromStatuses', () => {
  it('reads §3.5 inactive as "not delegated" — the same source as my-page', () => {
    expect(delegationFromStatuses(['inactive'])).toBe('none')
    expect(delegationFromStatuses(['ok'])).toBe('external')
    // ロックが付いていても委任の有無は inactive だけが決める。
    expect(delegationFromStatuses(['clientTransferProhibited'])).toBe('external')
  })
})

describe('DNS_CHECK_LABELS', () => {
  it('uses the exact spec wording for each state', () => {
    expect(DNS_CHECK_LABELS.unset.description).toBe('まだ設定していません')
    expect(DNS_CHECK_LABELS.notPublished.description).toBe(
      'ネームサーバーが未設定のため、まだインターネットに公開されていません',
    )
    expect(DNS_CHECK_LABELS.pending.description).toBe(
      '設定は保存されました。反映まで通常数分〜最大48時間かかります',
    )
    // ⚠️ 旧「つながっています ✓」に戻さないこと。当サービスのDNSは実DNSへ配信
    // しないので、あれは確認できていないことを断言する文だった (§6.3.1)。
    expect(DNS_CHECK_LABELS.ok.description).toBe('当サービスのDNSに登録されています ✓')
    expect(DNS_CHECK_LABELS.mismatch.description).toBe('期待値と実際の値が異なります')
  })
})
