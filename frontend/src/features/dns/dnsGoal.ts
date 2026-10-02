/**
 * 入口の1問目「このドメインを何に使いますか？」の答え。
 * URL の ?goal= に載るので、リテラルは軽々に変えない（戻る・リロードで維持する）。
 *
 * 'none' は「まだ何も用意していない」— 設定に進ませず、先に何を用意すべきかを
 * 案内する経路（DnsPrepareStep）へ向かう。
 */
export type DnsGoal = 'web' | 'mail' | 'none'

export function parseDnsGoal(raw: string | null): DnsGoal | null {
  return raw === 'web' || raw === 'mail' || raw === 'none' ? raw : null
}
