/**
 * DNS record types shared across the DNS feature (spec §6.3).
 *
 * The wire shape is intentionally identical to functions-stubs/src/types.ts
 * (no cross-package type plumbing — change both sides by hand). The api layer
 * (src/api/dnsApi.ts) imports these instead of redeclaring them.
 */

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']

export type DnsRecord = {
  type: DnsRecordType
  /** Relative name: '@' for the apex, or a label like 'www'. */
  name: string
  value: string
  ttl?: number
  /** MX only. */
  priority?: number
}
