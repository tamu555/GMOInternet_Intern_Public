/**
 * 「ドメインをつなぐ」画面 (docs/api-flow-diagrams.html FIG.11, spec §6.3)。
 * ルート: /domains/:domainName/dns（FIG.1 完了画面と FIG.10 詳細画面から誘導）。
 *
 * 入口は目的から入る（DnsEntryFlow）:
 *   何に使いますか？ → ホームページ / メール → §6.3.3(a) の1問 → mode 確定
 *                    → まだ何も用意していない → 先に何を用意するかの案内
 * §6.3.3(a) の分岐先は変わらない:
 *   はい            → NS変更モード（NsChangeMode — 実装済み updateDomain 行き）
 *   いいえ/IPをもらった → レコード設定モード（RecordEditorMode — スタブcallable行き）
 *
 * 答えは URL の ?goal=web|mail|none と ?mode=ns|records に保持し、リロード・
 * 戻るで維持する。?mode= だけを直接開く導線（features/assistant の routeManifest）
 * があるので、goal が無くても mode 単独で成立させること。
 *
 * ⚠️ この画面の既定の読み筋に DNS の用語を出さない。2階層（①②）の説明と用語は
 * 「くわしく知りたい方へ」の開閉部（DisclosurePanel）にだけ置く。
 */
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, messageForError } from '../../api/apiError'
import { fetchDnsRecords } from '../../api/dnsApi'
import { fetchMyDomain, type MyDomainDetail } from '../../api/myDomainsApi'
import { StatusBanner } from '../../components/StatusBanner'
import { INACTIVE_NOTICE } from '../mypage/mypageMessages'
import { CONNECT_PAGE_TITLE, MODE_BADGE_NS, MODE_BADGE_RECORDS } from './connectMessages'
import { delegationFromStatuses } from './dnsCheckStatus'
import { DnsEntryFlow } from './DnsEntryFlow'
import { parseDnsGoal, type DnsGoal } from './dnsGoal'
import { DNS_MODE_RESELECT_LABEL } from './dnsMessages'
import { parseDnsMode, type DnsMode } from './dnsMode'
import { DnsModeBanner } from './DnsModeBanner'
import type { DnsRecord } from './dnsRecordTypes'
import { NsChangeMode } from './NsChangeMode'
import { RecordEditorMode } from './RecordEditorMode'

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

export function DnsSetupPage() {
  const { domainName = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode = parseDnsMode(searchParams.get('mode'))
  const goal = parseDnsGoal(searchParams.get('goal'))

  const [domain, setDomain] = useState<MyDomainDetail | null>(null)
  const [savedRecords, setSavedRecords] = useState<DnsRecord[] | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [detail, records] = await Promise.all([
          fetchMyDomain(domainName, signal),
          fetchDnsRecords(domainName, signal),
        ])
        setDomain(detail.domain)
        setSavedRecords(records.records)
        setLoadError(null)
        setNotFound(false)
      } catch (error) {
        if (signal?.aborted) return
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true)
          return
        }
        setLoadError(messageForError(error))
      }
    },
    [domainName],
  )

  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount: every setState happens after an await.
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  /** 答えは URL に積む。戻る・リロードで消えると、初心者は同じ問いを2度読む。 */
  function selectMode(next: DnsMode) {
    setSearchParams(goal ? { goal, mode: next } : { mode: next })
  }

  function selectGoal(next: DnsGoal | null) {
    setSearchParams(next ? { goal: next } : {})
  }

  if (notFound) {
    return (
      <div className="flex w-full flex-col gap-4">
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>ドメインが見つかりません</AlertTitle>
          <AlertDescription>
            <p>このドメインは存在しないか、すでに管理対象から外れています。</p>
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="self-start">
          <Link to="/mypage">
            <ArrowLeft />
            一覧へ戻る
          </Link>
        </Button>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex w-full flex-col gap-4">
        <StatusBanner
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              再読み込み
            </Button>
          }
        >
          {loadError}
        </StatusBanner>
      </div>
    )
  }

  if (!domain || savedRecords === null) {
    return (
      <div className="w-full">
        <PageSkeleton />
      </div>
    )
  }

  /* 委任状態は §3.5 status ひとつを根拠にする（マイページの「まだインターネット
     に公開されていません」と同じ源）。バナーと確認パネルで判定が割れると、
     同じ画面のなかで矛盾した答えを出すことになる。 */
  const delegation = delegationFromStatuses(domain.statuses)
  const inactive = delegation === 'none'

  return (
    <div className="flex w-full flex-col gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/mypage/domains/${encodeURIComponent(domain.name)}`}>
            <ArrowLeft />
            ドメイン詳細へ戻る
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold tracking-tight">
            {CONNECT_PAGE_TITLE} — <span className="font-mono">{domain.name}</span>
          </h1>
          {mode ? <Badge variant="outline">{mode === 'ns' ? MODE_BADGE_NS : MODE_BADGE_RECORDS}</Badge> : null}
        </div>
      </div>

      {inactive ? <StatusBanner tone="info">{INACTIVE_NOTICE}</StatusBanner> : null}

      {mode === null ? (
        <DnsEntryFlow
          domainName={domain.name}
          goal={goal}
          onSelectGoal={selectGoal}
          onSelectMode={selectMode}
        />
      ) : (
        <>
          <div className="-mt-2">
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[13px]"
              onClick={() => selectGoal(goal)}
            >
              {DNS_MODE_RESELECT_LABEL}
            </Button>
          </div>
          <DnsModeBanner mode={mode} />
          {mode === 'ns' ? (
            <NsChangeMode domain={domain} onUpdated={setDomain} />
          ) : (
            <RecordEditorMode
              domainName={domain.name}
              saved={savedRecords}
              delegation={delegation}
              onSavedChange={setSavedRecords}
              onSwitchToNsMode={() => selectMode('ns')}
            />
          )}
        </>
      )}
    </div>
  )
}
