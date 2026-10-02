/**
 * STEP4「完了」: 保存できたことと、そのあと何をすればよいかを1画面にまとめる。
 *
 * ⚠️ 保存＝完成ではない（反映に時間がかかる）。ここで「次にやること」を出さないと
 * 初心者は「保存したのに見えない」で設定をいじり直し、本当に壊す（§6.3.3d）。
 * 保存済みの内容を持つドメインで画面を開いたときの「現在の設定」ビューも兼ねる。
 */
import { ListChecks, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBanner } from '../../components/StatusBanner'
import { DnsCheckPanel } from './DnsCheckPanel'
import {
  DONE_NEXT_STEPS,
  DONE_NEXT_TITLE,
  DONE_STEP_TITLE_CURRENT,
  DONE_STEP_TITLE_SAVED,
  RECORDS_SAVED_NOTICE,
} from './dnsMessages'
import type { DnsDelegation } from './dnsCheckStatus'
import { displayHost, summarizeConnections } from './dnsGuide'
import { TermTooltip } from './TermTooltip'
import type { DnsRecord } from './dnsRecordTypes'

export function DnsDoneStep({
  domainName,
  records,
  delegation,
  justSaved,
  onEdit,
}: {
  domainName: string
  records: DnsRecord[]
  /** 確認パネルへ渡す委任状態（DnsSetupPage が §3.5 status から求める）。 */
  delegation: DnsDelegation
  /** 直前に保存したのか、保存済みの設定を開いただけなのか。 */
  justSaved: boolean
  onEdit: () => void
}) {
  const webHost = records.find((record) => record.type === 'A' || record.type === 'CNAME')

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>{justSaved ? DONE_STEP_TITLE_SAVED : DONE_STEP_TITLE_CURRENT}</CardTitle>
          {/* 件数ではなく、この人にとって何ができる状態かを先に言う。 */}
          <CardDescription>
            {summarizeConnections(records, domainName)}
            <span className="mt-1 block text-xs">登録されている設定: {records.length}件</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {justSaved ? <StatusBanner tone="success">{RECORDS_SAVED_NOTICE}</StatusBanner> : null}

          <div className="rounded-xl bg-muted p-4">
            <p className="flex items-center gap-2 text-sm font-bold">
              <ListChecks aria-hidden="true" className="size-4 text-primary" />
              {DONE_NEXT_TITLE}
            </p>
            <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed">
              {DONE_NEXT_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {webHost ? (
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                確認先の目安:{' '}
                <span className="font-mono font-semibold text-foreground">
                  https://{displayHost(webHost.name, domainName)}
                </span>
              </p>
            ) : null}
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              <TermTooltip term="propagation" className="font-semibold text-foreground" />
              には時間がかかります。すぐに見えなくても設定は間違っていません。
            </p>
          </div>

          <div>
            <Button variant="outline" onClick={onEdit}>
              <Pencil />
              設定を変更する
            </Button>
          </div>
        </CardContent>
      </Card>

      <DnsCheckPanel domainName={domainName} records={records} delegation={delegation} />
    </div>
  )
}
