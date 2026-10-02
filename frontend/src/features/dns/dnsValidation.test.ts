import { describe, expect, it } from 'vitest'
import type { DnsRecord } from './dnsRecordTypes'
import { normalizeDnsRecord, validateDnsRecords } from './dnsValidation'

const A_OK: DnsRecord = { type: 'A', name: '@', value: '203.0.113.10' }
const WWW_OK: DnsRecord = { type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }

describe('validateDnsRecords — per-record errors', () => {
  it('accepts a valid web pair without errors', () => {
    const result = validateDnsRecords([A_OK, WWW_OK])
    expect(result.recordErrors.size).toBe(0)
  })

  it('rejects CNAME on the root (@)', () => {
    const result = validateDnsRecords([{ type: 'CNAME', name: '@', value: 'x.example.com' }])
    expect(result.recordErrors.get(0)?.type).toMatch(/ルートドメインにCNAME/)
  })

  it('rejects a CNAME coexisting with another record on the same name', () => {
    const result = validateDnsRecords([
      { type: 'CNAME', name: 'www', value: 'x.example.com' },
      { type: 'A', name: 'www', value: '203.0.113.10' },
    ])
    expect(result.recordErrors.get(1)?.name).toMatch(/CNAME/)
    expect(result.recordErrors.get(0)).toBeUndefined()
  })

  it('requires a priority on MX and bounds it to 0-65535', () => {
    const noPriority = validateDnsRecords([{ type: 'MX', name: '@', value: 'mail.example.com' }])
    expect(noPriority.recordErrors.get(0)?.priority).toMatch(/優先度/)

    const outOfRange = validateDnsRecords([
      { type: 'MX', name: '@', value: 'mail.example.com', priority: 70000 },
    ])
    expect(outOfRange.recordErrors.get(0)?.priority).toMatch(/0〜65535/)
  })

  it('rejects a non-IPv4 value on A and a non-IPv6 value on AAAA', () => {
    const badA = validateDnsRecords([{ type: 'A', name: '@', value: 'example.com' }])
    expect(badA.recordErrors.get(0)?.value).toMatch(/IPv4/)
    const badOctet = validateDnsRecords([{ type: 'A', name: '@', value: '999.0.0.1' }])
    expect(badOctet.recordErrors.get(0)?.value).toMatch(/IPv4/)
    const badAaaa = validateDnsRecords([{ type: 'AAAA', name: '@', value: '203.0.113.10' }])
    expect(badAaaa.recordErrors.get(0)?.value).toMatch(/IPv6/)
    const goodAaaa = validateDnsRecords([{ type: 'AAAA', name: '@', value: '2001:db8::1' }])
    expect(goodAaaa.recordErrors.size).toBe(0)
  })

  it('requires an FQDN-looking value on CNAME / NS / MX', () => {
    const result = validateDnsRecords([{ type: 'CNAME', name: 'www', value: 'localhost' }])
    expect(result.recordErrors.get(0)?.value).toMatch(/ホスト名/)
  })

  it('flags full-width characters and stray spaces (copy-paste accidents)', () => {
    const fullWidth = validateDnsRecords([{ type: 'A', name: '@', value: '２０3.0.113.10' }])
    expect(fullWidth.recordErrors.get(0)?.value).toMatch(/全角/)

    const spaced = validateDnsRecords([{ type: 'CNAME', name: 'www', value: 'x.example .com' }])
    expect(spaced.recordErrors.get(0)?.value).toMatch(/スペース/)
  })

  it('allows spaces inside TXT values (SPF) but still rejects full-width there', () => {
    const spf = validateDnsRecords([{ type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all' }])
    expect(spf.recordErrors.size).toBe(0)
  })

  it('rejects a duplicated SPF on the same name (複数行分割の事故)', () => {
    const result = validateDnsRecords([
      { type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all' },
      { type: 'TXT', name: '@', value: 'v=spf1 include:spf.protection.outlook.com -all' },
    ])
    expect(result.recordErrors.get(0)?.value).toMatch(/SPF/)
    expect(result.recordErrors.get(1)?.value).toMatch(/SPF/)
  })

  it('rejects a zero / negative / non-integer TTL', () => {
    for (const ttl of [0, -300, 1.5]) {
      const result = validateDnsRecords([{ ...A_OK, ttl }])
      expect(result.recordErrors.get(0)?.ttl, String(ttl)).toMatch(/TTL/)
    }
  })
})

describe('validateDnsRecords — warnings', () => {
  it('warns (not errors) about a trailing dot, which normalization removes', () => {
    const result = validateDnsRecords([{ type: 'CNAME', name: 'www', value: 'x.example.com.' }])
    expect(result.recordErrors.size).toBe(0)
    expect(result.warnings.some((warning) => warning.includes('末尾のドット'))).toBe(true)
  })

  it('warns when only www (or only the root) is configured for the web', () => {
    const onlyWww = validateDnsRecords([WWW_OK])
    expect(onlyWww.warnings.some((warning) => warning.includes('www の設定だけ'))).toBe(true)

    const onlyRoot = validateDnsRecords([A_OK])
    expect(onlyRoot.warnings.some((warning) => warning.includes('ルート（@）の設定だけ'))).toBe(true)

    const both = validateDnsRecords([A_OK, WWW_OK])
    expect(both.warnings).toEqual([])
  })
})

describe('normalizeDnsRecord', () => {
  it('trims, removes the trailing dot, folds full-width spaces and lowercases the name', () => {
    expect(
      normalizeDnsRecord({ type: 'CNAME', name: '　WWW ', value: ' x.Example.com. ' }),
    ).toEqual({ type: 'CNAME', name: 'www', value: 'x.Example.com' })
  })

  it('turns an empty name into "@"', () => {
    expect(normalizeDnsRecord({ type: 'A', name: '  ', value: '203.0.113.10' }).name).toBe('@')
  })
})
