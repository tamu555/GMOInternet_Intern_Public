/**
 * 貼り付けパーサ (spec §6.3.3c): ホスティング会社の設定案内のコピペを
 * DnsRecord の案に変換する。
 *
 * 仕様書いわく「正規表現＋ヒューリスティックで実装可能」— 完璧は狙わず、
 * よくある3形式を順に試し、どれにも当たらない行は skippedLines として
 * 返してユーザーに見せる（黙って捨てない）。
 *
 *   (a) ラベル形式   Type: CNAME / Name: www / Value: xxx（複数行ブロックも）
 *   (b) 表形式       CNAME  www  xxx.example.com  3600
 *   (c) zone file風  www 3600 IN CNAME xxx.example.com.
 */
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from './dnsRecordTypes'

export type ParseResult = {
  records: DnsRecord[]
  skippedLines: string[]
}

/** ラベル表記のゆれ → フィールド名（英語・日本語の主要な言い回しを吸収）。 */
const FIELD_LABELS: Array<{ field: 'type' | 'name' | 'value' | 'ttl' | 'priority'; pattern: RegExp }> = [
  { field: 'type', pattern: /^(?:record\s*type|type|タイプ|種別|レコード種別)$/i },
  { field: 'name', pattern: /^(?:host\s*name|host|name|ホスト名|ホスト|名前)$/i },
  { field: 'value', pattern: /^(?:points\s*to|value|content|data|値|内容|参照先)$/i },
  { field: 'ttl', pattern: /^ttl$/i },
  { field: 'priority', pattern: /^(?:priority|優先度|優先)$/i },
]

/** `ラベル : 値` の1組（値は次の区切り / , まで）。NFKC後なので : だけ見る。 */
const LABELED_PAIR = /([^\s:/,][^:/,]*?)\s*:\s*([^/,]+)/g

function fieldFor(label: string): 'type' | 'name' | 'value' | 'ttl' | 'priority' | undefined {
  const trimmed = label.trim()
  return FIELD_LABELS.find(({ pattern }) => pattern.test(trimmed))?.field
}

function asRecordType(token: string): DnsRecordType | undefined {
  const upper = token.trim().toUpperCase()
  return DNS_RECORD_TYPES.find((type) => type === upper)
}

function asPositiveInt(token: string | undefined): number | undefined {
  if (token === undefined) return undefined
  if (!/^\d+$/.test(token.trim())) return undefined
  return Number(token.trim())
}

/** 'apex' / 'root' / 空 などの言い回しを '@'（ルート）へ正規化する。 */
function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\.$/, '')
  if (name === '' || name === '@' || /^(?:apex|root|\(none\))$/i.test(name)) return '@'
  return name
}

/** TXT の値は案内文で引用符付きのことが多い — 剥がして保存形に揃える。 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && /^["']/.test(trimmed) && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

type PartialFields = Partial<Record<'type' | 'name' | 'value' | 'ttl' | 'priority', string>>

function recordFromFields(fields: PartialFields): DnsRecord | undefined {
  const type = fields.type ? asRecordType(fields.type) : undefined
  if (!type || fields.value === undefined) return undefined
  const value = type === 'TXT' ? stripQuotes(fields.value) : fields.value.trim()
  const ttl = asPositiveInt(fields.ttl)
  const priority = asPositiveInt(fields.priority)
  return {
    type,
    name: normalizeName(fields.name ?? ''),
    value,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

/** (a) ラベル形式: 1行内の全ペアを { field: 値 } に。ラベル不明のペアは無視。 */
function parseLabeledPairs(line: string): PartialFields | undefined {
  let found = false
  const fields: PartialFields = {}
  for (const match of line.matchAll(LABELED_PAIR)) {
    const field = fieldFor(match[1])
    if (!field) continue
    found = true
    fields[field] = match[2].trim()
  }
  return found ? fields : undefined
}

/** (c) zone file風: `name [ttl] IN TYPE value…`。 */
function parseZoneLine(line: string): DnsRecord | undefined {
  const match = /^(\S+)\s+(?:(\d+)\s+)?IN\s+(\S+)\s+(.+)$/i.exec(line)
  if (!match) return undefined
  const type = asRecordType(match[3])
  if (!type) return undefined
  let rest = match[4].trim()
  let priority: number | undefined
  if (type === 'MX') {
    const mx = /^(\d+)\s+(\S+)$/.exec(rest)
    if (mx) {
      priority = Number(mx[1])
      rest = mx[2]
    }
  }
  const value = (type === 'TXT' ? stripQuotes(rest) : rest).replace(/\.$/, '')
  const ttl = asPositiveInt(match[2])
  return {
    type,
    name: normalizeName(match[1]),
    value,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

/** (b) 表形式: `TYPE name value [ttl]`（MXは `TYPE name [priority] value [ttl]` も）。 */
function parseTabularLine(line: string): DnsRecord | undefined {
  const tokens = line.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length < 3) return undefined
  const type = asRecordType(tokens[0])
  if (!type) return undefined
  const name = normalizeName(tokens[1])
  const rest = tokens.slice(2)

  if (type === 'TXT') {
    // 引用符付きなら閉じ引用符まで、末尾に数値が残れば TTL とみなす。
    const joined = rest.join(' ')
    const quoted = /^(["'])(.*?)\1(?:\s+(\d+))?$/.exec(joined)
    if (quoted) {
      const ttl = asPositiveInt(quoted[3])
      return { type, name, value: quoted[2], ...(ttl !== undefined ? { ttl } : {}) }
    }
    return { type, name, value: stripQuotes(joined) }
  }

  if (type === 'MX' && asPositiveInt(rest[0]) !== undefined && rest[1] !== undefined) {
    // 優先度前置: MX @ 10 mail.example.com [ttl]
    const ttl = asPositiveInt(rest[2])
    return {
      type,
      name,
      value: rest[1].replace(/\.$/, ''),
      priority: asPositiveInt(rest[0]),
      ...(ttl !== undefined ? { ttl } : {}),
    }
  }

  // 通常の列順: value [ttl] [priority]
  const value = rest[0].replace(/\.$/, '')
  const ttl = asPositiveInt(rest[1])
  const priority = type === 'MX' ? asPositiveInt(rest[2]) : undefined
  return {
    type,
    name,
    value,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

export function parseDnsPaste(text: string): ParseResult {
  // NFKC で全角英数・全角コロン・全角スラッシュを半角へ、U+3000 は空白へ畳む。
  const lines = text.normalize('NFKC').split(/\r?\n/)

  const records: DnsRecord[] = []
  const skippedLines: string[] = []

  // (a) の複数行ブロック用: ラベル行を跨いで組み立て中のレコード。
  let pending: PartialFields = {}
  let pendingLines: string[] = []

  const flushPending = () => {
    if (pendingLines.length === 0) return
    const record = recordFromFields(pending)
    if (record) {
      records.push(record)
    } else {
      skippedLines.push(...pendingLines)
    }
    pending = {}
    pendingLines = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '') {
      flushPending()
      continue
    }

    const labeled = parseLabeledPairs(line)
    if (labeled) {
      // 同じフィールドが再登場したら前のブロックの終わり。
      if (Object.keys(labeled).some((field) => pending[field as keyof PartialFields] !== undefined)) {
        flushPending()
      }
      Object.assign(pending, labeled)
      pendingLines.push(rawLine)
      // ここでは確定しない: TTL/優先度 が後続行に続くブロック形式があるため、
      // ブロック終端（空行・非ラベル行・フィールド再登場・入力終端）で flush する。
      continue
    }
    flushPending()

    const zone = parseZoneLine(line)
    if (zone) {
      records.push(zone)
      continue
    }

    const tabular = parseTabularLine(line)
    if (tabular) {
      records.push(tabular)
      continue
    }

    // どの形式にも当たらない行（説明文など）は黙って捨てず一覧で返す。
    skippedLines.push(rawLine)
  }
  flushPending()

  return { records, skippedLines }
}
