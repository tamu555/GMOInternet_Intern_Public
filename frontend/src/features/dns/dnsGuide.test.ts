/**
 * summarizeConnections: 保存済みの内容を「件数」ではなく「利用者にとっての
 * 意味」に翻訳する1文。件数表示に戻る回帰を防ぐためのテスト。
 */
import { describe, expect, it } from 'vitest'
import { summarizeConnections } from './dnsGuide'
import type { DnsRecord } from './dnsRecordTypes'

const DOMAIN = 'example.com'

const A: DnsRecord = { type: 'A', name: '@', value: '203.0.113.10' }
const CNAME: DnsRecord = { type: 'CNAME', name: 'www', value: 'cname.example.net' }
const MX: DnsRecord = { type: 'MX', name: '@', value: 'smtp.example.net', priority: 10 }
const TXT: DnsRecord = { type: 'TXT', name: '@', value: 'v=spf1 -all' }

describe('summarizeConnections', () => {
  it('says nothing is connected yet when there are no records', () => {
    expect(summarizeConnections([], DOMAIN)).toBe(
      'いま、つなぎ先は1件も登録されていません。example.com と打っても、まだ何も表示されません。',
    )
  })

  it('reports a web-only set as the site being shown', () => {
    expect(summarizeConnections([A, CNAME], DOMAIN)).toBe(
      'example.com を開いた人に、指定した場所のホームページを表示する設定になっています。',
    )
  })

  it('reports a mail-only set as mail being delivered', () => {
    expect(summarizeConnections([MX], DOMAIN)).toBe(
      'example.com 宛のメールを、指定した場所に届ける設定になっています。',
    )
  })

  it('reports both when web and mail are present', () => {
    expect(summarizeConnections([A, MX], DOMAIN)).toBe(
      'example.com は、ホームページの表示先とメールの届け先の両方がそろっています。',
    )
  })

  it('does not claim a connection when only verification records exist', () => {
    expect(summarizeConnections([TXT], DOMAIN)).toBe(
      'example.com には、サービスから渡された確認用の情報だけが登録されています。ホームページやメールのつなぎ先はまだありません。',
    )
  })
})
