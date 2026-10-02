/**
 * §6.3.3(a) の分岐結果。URL の ?mode= に載るのでリテラルは変えない
 * （features/assistant の routeManifest が DNS_RECORDS / DNS_NAMESERVER の
 * 遷移先として同じ値を組み立てている）。
 */
export type DnsMode = 'ns' | 'records'

export function parseDnsMode(raw: string | null): DnsMode | null {
  return raw === 'ns' || raw === 'records' ? raw : null
}
