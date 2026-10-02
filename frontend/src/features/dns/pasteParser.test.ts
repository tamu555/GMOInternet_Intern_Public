import { describe, expect, it } from 'vitest'
import { parseDnsPaste } from './pasteParser'

describe('parseDnsPaste — (a) labeled format', () => {
  it('parses a single-line "Type: … / Name: … / Value: …" entry', () => {
    const result = parseDnsPaste('Type: CNAME / Name: www / Value: cname.vercel-dns.com')
    expect(result.records).toEqual([{ type: 'CNAME', name: 'www', value: 'cname.vercel-dns.com' }])
    expect(result.skippedLines).toEqual([])
  })

  it('parses a multi-line labeled block including TTL and priority', () => {
    const result = parseDnsPaste(
      ['Type: MX', 'Host: @', 'Value: smtp.google.com', 'TTL: 3600', 'Priority: 1'].join('\n'),
    )
    expect(result.records).toEqual([
      { type: 'MX', name: '@', value: 'smtp.google.com', ttl: 3600, priority: 1 },
    ])
  })

  it('splits consecutive blocks when a field reappears', () => {
    const result = parseDnsPaste(
      ['Type: A', 'Name: @', 'Value: 76.76.21.21', 'Type: CNAME', 'Name: www', 'Value: cname.vercel-dns.com'].join(
        '\n',
      ),
    )
    expect(result.records.map((record) => record.type)).toEqual(['A', 'CNAME'])
  })

  it('understands Japanese labels (種別 / ホスト名 / 値 / 優先度)', () => {
    const result = parseDnsPaste('種別: MX / ホスト名: @ / 値: mail.example.com / 優先度: 10')
    expect(result.records).toEqual([{ type: 'MX', name: '@', value: 'mail.example.com', priority: 10 }])
  })

  it('folds full-width characters (：・全角英数・全角スペース) before parsing', () => {
    const result = parseDnsPaste('Ｔｙｐｅ：　ＣＮＡＭＥ　／　Ｎａｍｅ：　ｗｗｗ　／　Ｖａｌｕｅ：　ｘ．ｅｘａｍｐｌｅ．ｃｏｍ')
    expect(result.records).toEqual([{ type: 'CNAME', name: 'www', value: 'x.example.com' }])
  })

  it('accepts "Points to" and "Content" as value labels', () => {
    const result = parseDnsPaste('Type: A, Host: @, Points to: 185.199.108.153')
    expect(result.records).toEqual([{ type: 'A', name: '@', value: '185.199.108.153' }])
  })
})

describe('parseDnsPaste — (b) tabular format', () => {
  it('parses "TYPE name value [ttl]" columns', () => {
    const result = parseDnsPaste('CNAME\twww\tapp.netlify.app\t3600')
    expect(result.records).toEqual([{ type: 'CNAME', name: 'www', value: 'app.netlify.app', ttl: 3600 }])
  })

  it('accepts the MX priority-before-value order (MX @ 10 mail.example.com)', () => {
    const result = parseDnsPaste('MX @ 10 mail.example.com')
    expect(result.records).toEqual([{ type: 'MX', name: '@', value: 'mail.example.com', priority: 10 }])
  })

  it('strips quotes from TXT values and keeps inner spaces', () => {
    const result = parseDnsPaste('TXT @ "v=spf1 include:_spf.google.com ~all"')
    expect(result.records).toEqual([{ type: 'TXT', name: '@', value: 'v=spf1 include:_spf.google.com ~all' }])
  })

  it('normalizes apex spellings (apex / root / 空) to "@"', () => {
    const result = parseDnsPaste(['A apex 76.76.21.21', 'A root 75.2.60.5'].join('\n'))
    expect(result.records.map((record) => record.name)).toEqual(['@', '@'])
  })
})

describe('parseDnsPaste — (c) zone-file format', () => {
  it('parses "name ttl IN TYPE value." and drops the trailing dot', () => {
    const result = parseDnsPaste('www 3600 IN CNAME xxx.example.com.')
    expect(result.records).toEqual([{ type: 'CNAME', name: 'www', value: 'xxx.example.com', ttl: 3600 }])
  })

  it('parses an MX zone line with the priority in the rdata', () => {
    const result = parseDnsPaste('@ IN MX 10 mail.example.com.')
    expect(result.records).toEqual([{ type: 'MX', name: '@', value: 'mail.example.com', priority: 10 }])
  })
})

describe('parseDnsPaste — skipped lines', () => {
  it('collects prose lines instead of silently dropping them', () => {
    const result = parseDnsPaste(
      ['以下のレコードを設定してください。', 'CNAME www cname.vercel-dns.com', 'ご不明な点はサポートまで。'].join('\n'),
    )
    expect(result.records).toHaveLength(1)
    expect(result.skippedLines).toEqual(['以下のレコードを設定してください。', 'ご不明な点はサポートまで。'])
  })

  it('returns no records and all lines skipped for non-DNS text', () => {
    const result = parseDnsPaste('こんにちは\nworld')
    expect(result.records).toEqual([])
    expect(result.skippedLines).toHaveLength(2)
  })

  it('sends an incomplete labeled block (no value) to skippedLines', () => {
    const result = parseDnsPaste('Type: CNAME\nName: www')
    expect(result.records).toEqual([])
    expect(result.skippedLines).toEqual(['Type: CNAME', 'Name: www'])
  })
})
