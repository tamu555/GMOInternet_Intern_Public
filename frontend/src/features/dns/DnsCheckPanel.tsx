/**
 * 「確認する」パネル (§6.3.3d): 保存済みレコードを (名前, 種別) のグループ
 * ごとに resolveDns（自作ミニリゾルバ Lv2 §6.3.2）へ問い合わせ、5状態
 * （未設定/未公開/反映待ち/確認できた/値が違う）で表示する。
 *
 * ⚠️ OK/NG の2値にしない — 保存直後に引けないのは正常（反映待ち）。
 * 「値が違う」だけが期待値と実際の値の差分を見せ、そこに直し方を添える。
 *
 * ⚠️ このパネルが答えられるのは「当サービスのDNSに登録できたか」までで、
 * 「世界から見えるか」ではない（レコードは実DNSへ配信されない）。後者は
 * レジストリ側の委任状態が決めるので、`delegation` を必ず受け取り、
 *   - 未設定 (§3.5 `inactive`) → ✓ を出さず「未公開」と、その直し方を出す
 *   - 外部委任                 → ✓ の意味を当サービスへの登録に限定し、
 *                                公開に使われていないことを注記する
 * を表示する。ここを省くとマイページの「まだインターネットに公開されて
 * いません」と画面同士が矛盾し、初心者は「✓ なのに見えない」で詰まる。
 *
 * 保存済みの内容だけを見る画面なので未保存状態は受け取らない（手順は
 * RecordEditorMode 側のステップが保証する）。
 *
 * 見出しは両モード共通で「つながったか確認する」— この画面が答える問いそのもの。
 * かんたんモードだけ '設定の確認' と名乗っていた時期があるが、同じ部品が
 * モードによって別の名前で現れると、通常モードへ切り替えた人が同じ画面を
 * 見失う。§1.2 の「部品は共有し variant で出し分ける」は見せ方の話であって、
 * 部品の名前を割る理由ではない。
 *
 * variant='easy' はかんたんモード用の見せ方（仕様 §1.2「UI部品は共有し、
 * variant で出し分ける」— 判定ロジックも画面も 2 セット作らない）:
 *   - 見出しを生 FQDN ではなく平易な日本語にする（表示名は recordLabel で
 *     受け取る。features/dns が features/easy を import しないための向き付け）
 *   - まだ「確認する」を押していない間は judgeDnsCheck の pending 判定を
 *     そのまま出す。保存直後は必ず引けないので、初心者に「今は反映待ちで
 *     正常」と先に伝えておく必要がある（§6.3.3d の落とし穴）
 * 通常モードの表示は variant 既定値のまま一切変わらない。
 */
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { messageForError } from '../../api/apiError'
import { resolveDns } from '../../api/dnsApi'
import { StatusBanner } from '../../components/StatusBanner'
import {
  CHECK_ACTUAL_LABEL,
  CHECK_EXPECTED_LABEL,
  CHECK_EXTERNAL_DELEGATION_NOTICE,
  CHECK_NOT_PUBLISHED_ACTION,
  CHECK_NOT_PUBLISHED_NOTICE,
  CHECK_PANEL_DESCRIPTION,
  CHECK_PANEL_TITLE,
} from './connectMessages'
import { CHECK_MISMATCH_HELP, RECORDS_NOT_SAVED_NOTICE } from './dnsMessages'
import {
  DNS_CHECK_LABELS,
  judgeDnsCheck,
  type DnsCheckOutcome,
  type DnsCheckState,
  type DnsDelegation,
} from './dnsCheckStatus'
import type { DnsRecord } from './dnsRecordTypes'

/** §3.5 と同じ思想: 色 + ラベルの併記（domainDisplay の tone クラスを流用）。 */
const CHECK_TONE_CLASSES: Record<DnsCheckState, string> = {
  unset: 'border-transparent bg-secondary text-muted-foreground',
  notPublished: 'border-transparent bg-status-info-bg text-status-info-fg',
  pending: 'border-transparent bg-status-info-bg text-status-info-fg',
  ok: 'border-transparent bg-grass-1 text-green-deep',
  mismatch: 'border-transparent bg-orange-soft text-orange-strong',
}

type CheckGroup = {
  key: string
  name: string
  type: DnsRecord['type']
  records: DnsRecord[]
}

function groupRecords(records: DnsRecord[]): CheckGroup[] {
  const groups = new Map<string, CheckGroup>()
  for (const record of records) {
    const name = record.name.trim().toLowerCase() || '@'
    const key = `${name}|${record.type}`
    const group = groups.get(key) ?? { key, name, type: record.type, records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function fqdnFor(name: string, domainName: string): string {
  return name === '@' ? domainName : `${name}.${domainName}`
}

export function DnsCheckPanel({
  domainName,
  records,
  delegation,
  variant = 'normal',
  recordLabel,
}: {
  domainName: string
  records: DnsRecord[]
  /** レジストリから見た委任状態（§3.5 status 由来）。判定と注記の両方で使う。 */
  delegation: DnsDelegation
  variant?: 'normal' | 'easy'
  /** variant='easy' の見出しに使う表示名リゾルバ（未指定なら種別をそのまま）。 */
  recordLabel?: (type: DnsRecord['type']) => string
}) {
  const [outcomes, setOutcomes] = useState<Record<string, DnsCheckOutcome>>({})
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [checkError, setCheckError] = useState<string | null>(null)

  const groups = groupRecords(records)

  async function check(group: CheckGroup) {
    setCheckError(null)
    setBusyKeys((current) => new Set(current).add(group.key))
    try {
      const result = await resolveDns(fqdnFor(group.name, domainName), group.type)
      setOutcomes((current) => ({
        ...current,
        [group.key]: judgeDnsCheck(group.records, result.records, delegation),
      }))
    } catch (error) {
      setCheckError(messageForError(error))
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current)
        next.delete(group.key)
        return next
      })
    }
  }

  async function checkAll() {
    // 逐次でなく並行に投げる（グループ間に依存は無い）。
    await Promise.all(groups.map((group) => check(group)))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{CHECK_PANEL_TITLE}</CardTitle>
        <CardDescription>{CHECK_PANEL_DESCRIPTION}</CardDescription>
        {groups.length > 0 ? (
          <CardAction>
            <Button variant="outline" size="sm" disabled={busyKeys.size > 0} onClick={() => void checkAll()}>
              <RefreshCw />
              すべて確認
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* 判定より先に、この確認が答えられない範囲（＝公開されるかどうか）を言う。 */}
        {delegation === 'none' ? (
          <StatusBanner
            tone="info"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/domains/${encodeURIComponent(domainName)}/dns?mode=ns`}>
                  {CHECK_NOT_PUBLISHED_ACTION}
                </Link>
              </Button>
            }
          >
            {CHECK_NOT_PUBLISHED_NOTICE}
          </StatusBanner>
        ) : (
          <StatusBanner tone="info">{CHECK_EXTERNAL_DELEGATION_NOTICE}</StatusBanner>
        )}

        {checkError ? <StatusBanner tone="error">{checkError}</StatusBanner> : null}

        {groups.length === 0 ? (
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={CHECK_TONE_CLASSES.unset}>
              {DNS_CHECK_LABELS.unset.label}
            </Badge>
            <p className="text-[13px] text-muted-foreground">
              {DNS_CHECK_LABELS.unset.description} — {RECORDS_NOT_SAVED_NOTICE}
            </p>
          </div>
        ) : (
          groups.map((group, index) => {
            /* かんたんモードは未確認のあいだ pending を既定表示にする。委任が
               未設定のときは全モードで既定表示にする（判定が応答に依らないので、
               押させてから同じ答えを出すのは初心者を1往復ぶん遠回りさせるだけ）。
               判定は judgeDnsCheck に一本化し、ここで状態を組み立て直さない。 */
            const showsDefaultOutcome = variant === 'easy' || delegation === 'none'
            const outcome =
              outcomes[group.key] ??
              (showsDefaultOutcome ? judgeDnsCheck(group.records, [], delegation) : undefined)
            const busy = busyKeys.has(group.key)
            return (
              <div key={group.key}>
                {index > 0 ? <Separator className="mb-3" /> : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    {variant === 'easy' ? (
                      <>
                        <p className="text-sm font-semibold">
                          {recordLabel ? recordLabel(group.type) : group.type}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                          {fqdnFor(group.name, domainName)}
                        </p>
                      </>
                    ) : (
                      <p className="font-mono text-sm font-semibold">
                        {fqdnFor(group.name, domainName)}{' '}
                        <span className="text-muted-foreground">（{group.type}）</span>
                      </p>
                    )}
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {group.records.map((record) => record.value).join(' / ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {outcome ? (
                      <Badge variant="outline" className={CHECK_TONE_CLASSES[outcome.state]}>
                        {DNS_CHECK_LABELS[outcome.state].label}
                      </Badge>
                    ) : null}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void check(group)}>
                      {busy ? '確認中…' : '確認する'}
                    </Button>
                  </div>
                </div>
                {outcome ? (
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    {DNS_CHECK_LABELS[outcome.state].description}
                  </p>
                ) : null}
                {outcome?.state === 'mismatch' ? (
                  <>
                    {/* §6.3.3(d): 「値が違う」だけは期待値と実際の値を並べて見せる。 */}
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-md bg-muted px-3 py-2">
                        <p className="text-xs font-semibold text-muted-foreground">{CHECK_EXPECTED_LABEL}</p>
                        {outcome.expected.map((record, i) => (
                          <p key={i} className="font-mono text-[13px]">
                            {record.value}
                            {record.priority !== undefined ? `（優先度 ${record.priority}）` : ''}
                          </p>
                        ))}
                      </div>
                      <div className="rounded-md bg-orange-soft/50 px-3 py-2">
                        <p className="text-xs font-semibold text-muted-foreground">{CHECK_ACTUAL_LABEL}</p>
                        {outcome.actual.map((record, i) => (
                          <p key={i} className="font-mono text-[13px]">
                            {record.value}
                            {record.priority !== undefined ? `（優先度 ${record.priority}）` : ''}
                          </p>
                        ))}
                      </div>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                      {CHECK_MISMATCH_HELP}
                    </p>
                  </>
                ) : null}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
