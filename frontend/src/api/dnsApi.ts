/**
 * DNS records API (docs/api-flow-diagrams.html FIG.11, spec §6.3),
 * speaking Firebase callables through invoke().
 *
 * All three callables are REAL (functions/src/api/dnsRecords.ts, backed by
 * Firestore dnsZones/{domainName}); the functions-stubs versions this module
 * was first wired against are deleted. The contract is unchanged:
 *
 *   listDnsRecords {domainName}            → {records[]}
 *   saveDnsRecords {domainName, records[]} → {records[]}  (全置換セマンティクス)
 *   resolveDns     {name(FQDN), type}      → {records[]}  (該当なしは空配列)
 *
 * Adapter notes:
 * - saveDnsRecords is full-replacement on purpose: the editor sends the whole
 *   record set as of save time, never a delta.
 * - resolveDns answering an EMPTY array is NOT an error — the confirm button
 *   folds it into the「反映待ち」state (§6.3.3d), so no not-found mapping here.
 * - The callable JSON layer serialises an absent ttl/priority as null, but the
 *   FE type says `ttl?: number` — sanitiseRecords() drops the nulls so saved
 *   state compares cleanly against locally-built records (undefined === 無指定).
 */
import { invoke } from './callable'
import type { DnsRecord, DnsRecordType } from '../features/dns/dnsRecordTypes'

/** Wire shape: optional numbers come back as null over the callable JSON. */
type DnsRecordWire = Omit<DnsRecord, 'ttl' | 'priority'> & {
  ttl?: number | null
  priority?: number | null
}

function sanitiseRecords(result: { records: DnsRecordWire[] }): { records: DnsRecord[] } {
  return {
    records: result.records.map((record) => ({
      type: record.type,
      name: record.name,
      value: record.value,
      ...(typeof record.ttl === 'number' ? { ttl: record.ttl } : {}),
      ...(typeof record.priority === 'number' ? { priority: record.priority } : {}),
    })),
  }
}

export async function fetchDnsRecords(
  domainName: string,
  signal?: AbortSignal,
): Promise<{ records: DnsRecord[] }> {
  return sanitiseRecords(
    await invoke<{ domainName: string }, { records: DnsRecordWire[] }>(
      'listDnsRecords',
      { domainName },
      { signal },
    ),
  )
}

export async function saveDnsRecords(
  domainName: string,
  records: DnsRecord[],
): Promise<{ records: DnsRecord[] }> {
  return sanitiseRecords(
    await invoke<{ domainName: string; records: DnsRecord[] }, { records: DnsRecordWire[] }>(
      'saveDnsRecords',
      { domainName, records },
    ),
  )
}

export async function resolveDns(
  name: string,
  type: DnsRecordType,
  signal?: AbortSignal,
): Promise<{ records: DnsRecord[] }> {
  return sanitiseRecords(
    await invoke<{ name: string; type: DnsRecordType }, { records: DnsRecordWire[] }>(
      'resolveDns',
      { name, type },
      { signal },
    ),
  )
}
