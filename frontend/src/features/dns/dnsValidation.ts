/**
 * 保存前バリデーション (spec §6.3.3e): 初心者がやりがちな事故を保存前に止める。
 *
 * features/domains/validation.ts と同じ思想 — バックエンド（スタブ含む）も
 * 検証するが、ここはフォーム上でその場で直させる UX 層。エラーメッセージは
 * 「何をどうすればよいか」まで書く（専門用語を消さず、説明を添える §1.2）。
 */
import type { DnsRecord } from './dnsRecordTypes'

export type RecordFieldErrors = Partial<Record<'type' | 'name' | 'value' | 'ttl' | 'priority', string>>

export type DnsValidationResult = {
  /** レコード配列の index → 項目別エラー。空 Map ならエラーなし。 */
  recordErrors: Map<number, RecordFieldErrors>
  /** 保存は止めないが伝えるべきこと（www有無の非対称など）。 */
  warnings: string[]
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
/** 簡易チェック: 16進とコロンのみ・コロンを含む（厳密な形式検査はしない）。 */
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/
const FQDN_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/

function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value)
  if (!match) return false
  return match.slice(1).every((octet) => Number(octet) <= 255)
}

function isIpv6(value: string): boolean {
  return value.includes(':') && IPV6_PATTERN.test(value)
}

function isFqdn(value: string): boolean {
  const bare = value.replace(/\.$/, '')
  return bare.includes('.') && FQDN_PATTERN.test(bare)
}

function hasNonAscii(value: string): boolean {
  return [...value].some((char) => (char.codePointAt(0) ?? 0) > 0x7f)
}

/** SPF は「複数行に分割」が事故の定番 (§6.3.3e) — v=spf1 で始まる TXT を数える。 */
function isSpf(record: DnsRecord): boolean {
  return record.type === 'TXT' && record.value.trim().toLowerCase().startsWith('v=spf1')
}

export function validateDnsRecords(records: DnsRecord[]): DnsValidationResult {
  const recordErrors = new Map<number, RecordFieldErrors>()
  const warnings: string[] = []

  const addError = (index: number, field: keyof RecordFieldErrors, message: string) => {
    const existing = recordErrors.get(index) ?? {}
    // 先勝ち: 同じ項目に複数の問題があっても最初の1つだけ見せる。
    if (existing[field] === undefined) existing[field] = message
    recordErrors.set(index, existing)
  }

  records.forEach((record, index) => {
    const value = record.value.trim()
    const name = record.name.trim()

    // 全角・空白の混入（コピペ事故の定番）。TXT の値は空白を含んでよい。
    if (hasNonAscii(name) || /\s/.test(name)) {
      addError(index, 'name', '名前に全角文字やスペースが混ざっています。半角英数字で入力してください。')
    }
    if (hasNonAscii(value)) {
      addError(index, 'value', '値に全角文字が混ざっています。コピー元を確認して半角で入力し直してください。')
    } else if (record.type !== 'TXT' && /\s/.test(value)) {
      addError(index, 'value', '値にスペースが混ざっています。前後の余分な文字を削除してください。')
    }

    if (value === '') {
      addError(index, 'value', '値を入力してください。')
    }

    // 種別ごとの値の形式。
    if (value !== '' && !hasNonAscii(value)) {
      switch (record.type) {
        case 'A':
          if (!isIpv4(value)) {
            addError(index, 'value', 'AレコードにはIPv4アドレス（例: 203.0.113.10）を入力してください。')
          }
          break
        case 'AAAA':
          if (!isIpv6(value)) {
            addError(index, 'value', 'AAAAレコードにはIPv6アドレス（例: 2001:db8::1）を入力してください。')
          }
          break
        case 'CNAME':
        case 'NS':
        case 'MX':
          if (/\s/.test(value) || !isFqdn(value)) {
            addError(
              index,
              'value',
              'ホスト名（例: cname.example.com のようなドットを含む形式）を入力してください。',
            )
          }
          break
        case 'TXT':
          break
      }
    }

    // ルートへの CNAME は不可（DNS の仕様上、他のレコードと共存できないため）。
    if (record.type === 'CNAME' && (name === '@' || name === '')) {
      addError(index, 'type', 'ルートドメインにCNAMEは設定できません。Aレコードを使ってください。')
    }

    // MX は優先度必須。
    if (record.type === 'MX') {
      if (record.priority === undefined) {
        addError(index, 'priority', 'MXレコードには優先度（0〜65535の数値）が必要です。')
      } else if (!Number.isInteger(record.priority) || record.priority < 0 || record.priority > 65535) {
        addError(index, 'priority', '優先度は0〜65535の整数で入力してください。')
      }
    }

    // TTL は正の整数のみ（推奨範囲 60〜86400 は強制しない）。
    if (record.ttl !== undefined && (!Number.isInteger(record.ttl) || record.ttl <= 0)) {
      addError(index, 'ttl', 'TTLは1以上の整数（秒）で入力してください。')
    }

    // 値末尾のドットは保存時に自動で取り除く（normalizeDnsRecord）— 警告のみ。
    if (value.endsWith('.') && !recordErrors.get(index)?.value) {
      const warning = '値の末尾のドット（.）は保存時に自動で取り除かれます。'
      if (!warnings.includes(warning)) warnings.push(warning)
    }
  })

  // 同一の名前に CNAME と他のレコードは共存できない（DNS の仕様）。
  const namesWithCname = new Set(
    records.filter((record) => record.type === 'CNAME').map((record) => record.name.trim() || '@'),
  )
  records.forEach((record, index) => {
    if (record.type === 'CNAME') return
    const name = record.name.trim() || '@'
    if (namesWithCname.has(name)) {
      addError(
        index,
        'name',
        `「${name}」にはCNAMEが設定されています。CNAMEがある名前には他のレコードを置けません。`,
      )
    }
  })

  // SPF（v=spf1 の TXT）は同じ名前に1本だけ（複数あると受信側が両方無効と扱う）。
  const spfCountByName = new Map<string, number>()
  for (const record of records.filter(isSpf)) {
    const name = record.name.trim() || '@'
    spfCountByName.set(name, (spfCountByName.get(name) ?? 0) + 1)
  }
  records.forEach((record, index) => {
    if (!isSpf(record)) return
    const name = record.name.trim() || '@'
    if ((spfCountByName.get(name) ?? 0) > 1) {
      addError(
        index,
        'value',
        'SPF（v=spf1 のTXT）は同じ名前に1本だけにしてください。複数行に分けると両方無効になります。',
      )
    }
  })

  // www有無の注意 (§6.3.3e): 片側だけ設定して「wwwなしだと開けない」事故を防ぐ。
  const webRecords = records.filter((record) => record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME')
  const hasRoot = webRecords.some((record) => (record.name.trim() || '@') === '@')
  const hasWww = webRecords.some((record) => record.name.trim().toLowerCase() === 'www')
  if (hasWww && !hasRoot) {
    warnings.push(
      'www の設定だけがあります。www なし（example.com）でもアクセスさせたい場合はルート（@）にもレコードが必要です。',
    )
  }
  if (hasRoot && !hasWww) {
    warnings.push(
      'ルート（@）の設定だけがあります。www 付き（www.example.com）でもアクセスさせたい場合は www にもレコードが必要です。',
    )
  }

  return { recordErrors, warnings }
}

/**
 * 保存直前の正規化: UI はこれを通した結果を saveDnsRecords へ送る。
 * 全角スペース→半角・前後trim・値末尾ドット除去・名前の小文字化・空名→'@'。
 */
export function normalizeDnsRecord(record: DnsRecord): DnsRecord {
  const clean = (raw: string) => raw.replace(/　/g, ' ').trim()
  const name = clean(record.name).toLowerCase()
  return {
    ...record,
    name: name === '' ? '@' : name,
    value: clean(record.value).replace(/\.$/, ''),
  }
}
