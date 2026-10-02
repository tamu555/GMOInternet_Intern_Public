/**
 * 編集中の1行（DraftRow）とワイヤ形（DnsRecord）の相互変換。
 *
 * 数値項目は入力欄そのままの文字列で持ち、変換は保存時に行う — 「3600」を
 * 打っている途中の「36」を数値に丸めてしまわないため。RecordEditorMode と
 * RecordCard の双方から使うので、型と変換だけをここに切り出している。
 */
import type { DnsRecord, DnsRecordType } from './dnsRecordTypes'

export type DraftRow = {
  id: number
  type: DnsRecordType
  name: string
  value: string
  ttl: string
  priority: string
}

let nextRowId = 1

export function rowFromRecord(record: DnsRecord): DraftRow {
  return {
    id: nextRowId++,
    type: record.type,
    name: record.name,
    value: record.value,
    ttl: record.ttl !== undefined ? String(record.ttl) : '',
    priority: record.priority !== undefined ? String(record.priority) : '',
  }
}

export function emptyRow(): DraftRow {
  return { id: nextRowId++, type: 'A', name: '', value: '', ttl: '', priority: '' }
}

/**
 * 入力欄の文字列 → ワイヤ形。空欄は undefined、数値でない入力は NaN のまま
 * validateDnsRecords に渡して「整数で入力してください」を出させる。
 */
export function recordFromRow(row: DraftRow): DnsRecord {
  const ttl = row.ttl.trim() === '' ? undefined : Number(row.ttl)
  const priority = row.priority.trim() === '' ? undefined : Number(row.priority)
  return {
    type: row.type,
    name: row.name,
    value: row.value,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
}

/** 重複追加ガード用のキー（テンプレート・貼り付けの2重取り込み対策）。 */
export function dedupeKey(record: DnsRecord): string {
  const name = record.name.trim().toLowerCase() || '@'
  return `${record.type}|${name}|${record.value.trim().toLowerCase()}`
}
