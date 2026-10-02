/**
 * STEP3「確認」: 保存を実行する前に、保存後の姿と失われる設定を見せる。
 *
 * saveDnsRecords は全置換なので「今ある設定が消える」ことが最大の事故要因
 * （§6.3.3e）。ここでは 1行ずつを平易な日本語（describeRecord）に言い換えて、
 * DNSの読み方を知らなくても内容が確認できるようにしている。
 */
import { AlertTriangle, ArrowLeft, Save } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBanner } from '../../components/StatusBanner'
import { CONFIRM_EMPTY_WARNING, CONFIRM_STEP_HINT, CONFIRM_STEP_TITLE } from './dnsMessages'
import { describeRecord, displayHost } from './dnsGuide'
import type { DnsRecord } from './dnsRecordTypes'
import { dedupeKey } from './draftRows'

/** ttl / priority の違いも「変更」として見えるようにキーへ含める。 */
function fullKey(record: DnsRecord): string {
  return `${dedupeKey(record)}|${record.ttl ?? ''}|${record.priority ?? ''}`
}

function RecordLine({
  record,
  domainName,
  badge,
  tone,
}: {
  record: DnsRecord
  domainName: string
  badge?: string
  tone: 'keep' | 'remove'
}) {
  return (
    <li className={tone === 'remove' ? 'rounded-lg bg-sun/60 p-3' : 'rounded-lg bg-muted p-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {record.type}
        </Badge>
        <span className="font-mono text-[13px] font-semibold">
          {displayHost(record.name, domainName)}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
        <span className="font-mono text-[13px] break-all">{record.value}</span>
        {badge ? <Badge variant="secondary">{badge}</Badge> : null}
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {describeRecord(record, domainName)}
      </p>
    </li>
  )
}

export function DnsConfirmStep({
  domainName,
  records,
  saved,
  busy,
  actionError,
  onBack,
  onSave,
}: {
  domainName: string
  /** 保存されるものそのもの（normalizeDnsRecord 済み）。 */
  records: DnsRecord[]
  saved: DnsRecord[]
  busy: boolean
  actionError: string | null
  onBack: () => void
  onSave: () => void
}) {
  const savedKeys = new Set(saved.map(fullKey))
  const draftKeys = new Set(records.map(fullKey))
  const removed = saved.filter((record) => !draftKeys.has(fullKey(record)))
  const addedCount = records.filter((record) => !savedKeys.has(fullKey(record))).length

  return (
    <Card>
      <CardHeader>
        <CardTitle>{CONFIRM_STEP_TITLE}</CardTitle>
        <CardDescription>{CONFIRM_STEP_HINT}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actionError ? <StatusBanner tone="error">{actionError}</StatusBanner> : null}

        {records.length === 0 ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>ご確認ください</AlertTitle>
            <AlertDescription>
              <p>{CONFIRM_EMPTY_WARNING}</p>
            </AlertDescription>
          </Alert>
        ) : (
          <div>
            <p className="text-sm font-semibold">
              保存後の設定（{records.length}件
              {addedCount > 0 ? `・うち新しく追加 ${addedCount}件` : ''}）
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {records.map((record, index) => (
                <RecordLine
                  key={index}
                  record={record}
                  domainName={domainName}
                  tone="keep"
                  badge={savedKeys.has(fullKey(record)) ? undefined : '追加'}
                />
              ))}
            </ul>
          </div>
        )}

        {removed.length > 0 ? (
          <div>
            <p className="text-sm font-semibold text-orange-strong">
              保存するとなくなる設定（{removed.length}件）
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {removed.some((record) => record.type === 'MX')
                ? 'メールの届け先（MX）がなくなるため、このドメイン宛のメールは届かなくなります。'
                : 'ここに残したいものがあれば、「入力に戻る」で追加し直してください。'}
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {removed.map((record, index) => (
                <RecordLine key={index} record={record} domainName={domainName} tone="remove" />
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={busy} onClick={onBack}>
            <ArrowLeft />
            入力に戻る
          </Button>
          <Button disabled={busy} onClick={onSave}>
            <Save />
            {busy ? '保存中…' : '保存する'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
