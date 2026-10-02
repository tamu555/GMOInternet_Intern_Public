/**
 * NS変更モード (§6.3.3a「はい」側): 委任先の差し替え。マイページの
 * NameserverDialog と同じ入力・バリデーションの流儀で、保存先も同じ
 * updateMyDomain(name, {nameservers}) — 実装済み updateDomain callable 行き。
 * §6.3.3(e) の警告（レコード無効化・メールも止まる）は仕様必須の固定表示。
 *
 * 1画面で終わるモードだが、進行表示は出す（DNS_NS_STEPS）。初心者にとっては
 * 「あと何回画面が変わるのか」が見えていること自体が、手を止めない理由になる。
 */
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { messageForError } from '../../api/apiError'
import { updateMyDomain, type MyDomainDetail } from '../../api/myDomainsApi'
import { StatusBanner } from '../../components/StatusBanner'
import { NS_CHANGE_WARNING } from '../mypage/mypageMessages'
import { JARGON_DISCLOSURE_LABEL } from './connectMessages'
import { DisclosurePanel } from './DisclosurePanel'
import { DNS_NS_STEPS } from './dnsEditorSteps'
import {
  NS_MODE_DONE_NEXT,
  NS_MODE_LEAD,
  NS_MODE_RECORDS_DISABLED_NOTE,
  NS_MODE_TECHNICAL_NOTE,
} from './dnsMessages'
import { DnsStepper } from './DnsStepper'

export function NsChangeMode({
  domain,
  onUpdated,
}: {
  domain: MyDomainDetail
  onUpdated: (domain: MyDomainDetail) => void
}) {
  const [hosts, setHosts] = useState<string[]>([domain.nameservers[0] ?? '', domain.nameservers[1] ?? ''])
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    const cleaned = hosts.map((host) => host.trim()).filter((host) => host.length > 0)
    if (cleaned.length === 0) {
      setFieldError('ネームサーバーを1つ以上入力してください。')
      return
    }
    if (cleaned.some((host) => !host.includes('.') || /\s/.test(host) || host.length > 255)) {
      setFieldError('ホスト名は ns1.example.com のようなFQDN形式で入力してください。')
      return
    }
    setFieldError(null)
    setActionError(null)
    setNotice(null)
    setBusy(true)
    try {
      const result = await updateMyDomain(domain.name, { nameservers: cleaned })
      onUpdated(result.domain)
      setHosts([result.domain.nameservers[0] ?? '', result.domain.nameservers[1] ?? ''])
      setNotice('ネームサーバーを変更しました。反映まで時間がかかる場合があります。')
    } catch (error) {
      setActionError(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <DnsStepper steps={DNS_NS_STEPS} current={notice ? 'ns-done' : 'ns-input'} />

      <Card>
        <CardHeader>
          <CardTitle>ネームサーバーを変更する</CardTitle>
          <CardDescription>
            {NS_MODE_LEAD}
            <span className="mt-1.5 block text-xs">
              対象のドメイン: <span className="font-mono font-semibold">{domain.name}</span>
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>変更前にご確認ください</AlertTitle>
            <AlertDescription>
              <p>{NS_CHANGE_WARNING}</p>
              <p>{NS_MODE_RECORDS_DISABLED_NOTE}</p>
            </AlertDescription>
          </Alert>

          {actionError ? <StatusBanner tone="error">{actionError}</StatusBanner> : null}
          {notice ? (
            <StatusBanner tone="success">
              {notice}
              <span className="mt-1 block text-[13px] leading-relaxed">{NS_MODE_DONE_NEXT}</span>
            </StatusBanner>
          ) : null}

          <div>
            <p className="text-sm font-semibold">現在のネームサーバー</p>
            {domain.nameservers.length > 0 ? (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {domain.nameservers.map((host) => (
                  <li key={host} className="rounded-md bg-muted px-3 py-2 font-mono text-[13px]">
                    {host}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-muted-foreground">未設定です。</p>
            )}
          </div>

          <div className="flex flex-col gap-3">
            {hosts.map((host, index) => (
              <label key={index} className="flex flex-col gap-1.5 text-sm font-semibold">
                ネームサーバー{index + 1}
                <input
                  type="text"
                  className="h-10 rounded-md border border-input bg-card px-3 font-mono text-sm font-normal placeholder:text-ink-hint"
                  placeholder={`ns${index + 1}.example.com`}
                  value={host}
                  disabled={busy}
                  onChange={(event) =>
                    setHosts((current) => current.map((value, i) => (i === index ? event.target.value : value)))
                  }
                />
              </label>
            ))}
            {fieldError ? <p className="text-[13px] font-semibold text-destructive">{fieldError}</p> : null}
          </div>

          <div>
            <Button disabled={busy} onClick={() => void handleSubmit()}>
              {busy ? '変更中…' : '変更を保存する'}
            </Button>
          </div>

          {/* 何が起きるかの技術的な説明は、読みたい人にだけ（§1.4: 用語は残す）。 */}
          <DisclosurePanel label={JARGON_DISCLOSURE_LABEL}>
            <p>{NS_MODE_TECHNICAL_NOTE}</p>
          </DisclosurePanel>
        </CardContent>
      </Card>
    </div>
  )
}
