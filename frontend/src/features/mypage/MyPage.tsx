/**
 * マイページ：ドメイン一覧 (docs/api-flow-diagrams.html FIG.9).
 *
 * §6.5 (確定): no trash-can metaphor - the list is split into アクティブ /
 * ライフサイクル終盤 sections, coloured by status WITH labels (§3.5).
 * ⚠️ The registry auto-renews expired domains (§3.6), so the second section
 * holds pendingDelete/pendingTransfer states, not "expired" domains.
 */
import { ArrowLeftRight, BellRing, ChevronRight, Globe, UserRound, Undo2 } from 'lucide-react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { StatusBanner } from '../../components/StatusBanner'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { messageForError } from '../../api/apiError'
import { useAuth } from '../../auth/useAuth'
import { firestore } from '../../firebase/client'
import { fetchMyDomains, restoreMyDomain, type MyDomainSummary } from '../../api/myDomainsApi'
import {
  ensureTransferNotificationsDrained,
  fetchTransferOutRequests,
  respondTransferOut,
  TRANSFER_REFRESH_MS,
  type Transfer,
} from '../../api/transferApi'
import {
  cancelDomainWatch,
  fetchDomainWatches,
  type DomainWatch,
} from '../../api/watchesApi'
import {
  canRestore,
  daysLeftUntil,
  daysUntil,
  expiryIndicatorClass,
  expiryProgressPercent,
  formatDateJa,
  formatDateTimeJa,
} from './domainDisplay'
import { TransferInSection } from '../transfer/TransferInSection'
import {
  RESTORE_WINDOW_ENDED_LABEL,
  TRANSFER_AUTO_APPROVE_WARNING,
  WATCH_AVAILABILITY_CAVEAT,
} from './mypageMessages'
import { StatusBadges } from './StatusBadges'

const ENDING_STATUSES = ['pendingDelete', 'pendingTransfer']

function isEnding(domain: MyDomainSummary): boolean {
  return domain.statuses.some((status) => ENDING_STATUSES.includes(status))
}

function detailPath(name: string): string {
  return `/mypage/domains/${encodeURIComponent(name)}`
}

/** 残り日数 + バー + 自動更新の状態。§6.4: 両者は同じ視覚的比重で並べる. */
function ExpiryCell({ domain }: { domain: MyDomainSummary }) {
  const remaining = daysUntil(domain.exDate)
  return (
    <div className="w-full sm:w-52">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-muted-foreground">残り{remaining}日</span>
        <span className={domain.autoRenew ? 'font-semibold text-primary' : 'font-semibold text-orange-strong'}>
          自動更新{domain.autoRenew ? 'ON' : 'OFF'}
        </span>
      </div>
      <Progress
        value={expiryProgressPercent(domain.exDate)}
        className="mt-1.5 h-1.5"
        indicatorClassName={expiryIndicatorClass(remaining)}
      />
      <p className="mt-1 text-xs text-ink-faint">{formatDateJa(domain.exDate)} まで</p>
    </div>
  )
}

function DomainRow({ domain, onRestore }: { domain: MyDomainSummary; onRestore: (name: string) => void }) {
  const pendingDelete = domain.statuses.includes('pendingDelete')
  // §6.5 / RGP: 復旧できるのは redemptionPeriod の間だけ。pendingDelete が
  // 残っていても期間が終わっていればボタンは出さない（押しても2304になる）.
  const restorable = canRestore(domain)
  const restorableDays = domain.restorableUntil ? daysLeftUntil(domain.restorableUntil) : null

  return (
    <li className="group relative flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-accent/40 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        {/* Stretched link: the whole row navigates, real buttons sit above it (z-10). */}
        <Link
          to={detailPath(domain.name)}
          className="font-mono text-sm font-semibold text-foreground no-underline after:absolute after:inset-0 hover:text-primary"
        >
          {domain.name}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <StatusBadges
            statuses={domain.statuses}
            rgpStatuses={domain.rgpStatuses}
            autoRenewCancelableUntil={domain.autoRenewCancelableUntil}
          />
        </div>
      </div>

      {pendingDelete ? (
        <div className="flex shrink-0 items-center gap-3">
          {restorable ? (
            <>
              {restorableDays !== null ? (
                <span className="text-[13px] font-semibold text-orange-strong">
                  あと{restorableDays}日は戻せます
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="relative z-10"
                onClick={() => onRestore(domain.name)}
              >
                <Undo2 />
                復旧する
              </Button>
            </>
          ) : (
            <span className="text-[13px] font-semibold text-muted-foreground">
              {RESTORE_WINDOW_ENDED_LABEL}
            </span>
          )}
        </div>
      ) : (
        <div className="shrink-0 sm:w-52">
          <ExpiryCell domain={domain} />
        </div>
      )}

      <ChevronRight className="hidden size-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 sm:block" />
    </li>
  )
}

const GONE_REASON_LABEL: Record<'transferred' | 'unrecoverable', string> = {
  transferred: '移管済み',
  unrecoverable: '復旧不可',
}

/**
 * 使用不可: domains the member used to hold. Informational only — no link,
 * no buttons, muted styling. Kept on the list so 「あのドメインはどうなった」
 * has an answer, with the reason (移管済み / 復旧不可) as that answer.
 */
function GoneSection({ domains }: { domains: MyDomainSummary[] }) {
  if (domains.length === 0) return null
  return (
    <section aria-label="使用不可">
      <div className="mb-2 mt-8 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-muted-foreground">使用不可</h2>
        <p className="text-[13px] text-ink-faint">
          お手続きが完了し、当サービスの管理を離れたドメイン
        </p>
      </div>
      <Card>
        <ul className="divide-y divide-border">
          {domains.map((domain) => (
            <li
              key={domain.name}
              className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <span className="font-mono text-sm font-semibold text-muted-foreground line-through decoration-ink-faint/60">
                  {domain.name}
                </span>
              </div>
              <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                {GONE_REASON_LABEL[domain.goneReason ?? 'unrecoverable']}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}

function DomainSection({
  title,
  description,
  domains,
  onRestore,
}: {
  title: string
  description: string
  domains: MyDomainSummary[]
  onRestore: (name: string) => void
}) {
  if (domains.length === 0) return null
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>
      <Card className="py-0">
        <ul className="divide-y divide-border">
          {domains.map((domain) => (
            <DomainRow key={domain.name} domain={domain} onRestore={onRestore} />
          ))}
        </ul>
      </Card>
    </section>
  )
}

/**
 * FIG.9 移管OUT通知 → FIG.3 下帯の承認/拒否.
 * Deliberate raw-Alert usage (DESIGN_SYSTEM.md prefers StatusBanner): this is
 * a titled, multi-line notice with its own action buttons, beyond what the
 * one-line StatusBanner expresses.
 */
function TransferRequestAlert({
  notice,
  busy,
  onApprove,
  onReject,
}: {
  notice: Transfer
  busy: boolean
  onApprove: () => void
  onReject: () => void
}) {
  return (
    <Alert variant="warning">
      <ArrowLeftRight />
      <AlertTitle>移管申請が来ています</AlertTitle>
      <AlertDescription>
        <p>
          <strong className="font-mono">{notice.domainName}</strong>{' '}
          について、他社レジストラへの移管（引っ越し）の申請が届いています。
        </p>
        {/* ⚠️ §6.6.1: 放置は「拒否」ではなく自動承認。期限はバックエンド計算値. */}
        <p>
          {TRANSFER_AUTO_APPROVE_WARNING}
          {notice.autoApproveAt ? `（自動承認: ${formatDateTimeJa(notice.autoApproveAt)}）` : null}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onApprove}>
            承認して移管する
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onReject}>
            拒否する
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * 空き待ち通知の本体 (docs/仕様/domain-watch.md): the sweep confirmed the
 * watched name free, so the member is invited into the ordinary purchase
 * flow. An invitation, not a reservation — WATCH_AVAILABILITY_CAVEAT is
 * mandatory here, because several members may have watched the same name.
 */
function WatchAvailableAlert({
  watch,
  busy,
  onCancel,
}: {
  watch: DomainWatch
  busy: boolean
  onCancel: () => void
}) {
  return (
    <Alert>
      <BellRing />
      <AlertTitle>空き待ちのドメインが購入できるようになりました</AlertTitle>
      <AlertDescription>
        <p>
          <strong className="font-mono">{watch.domainName}</strong> の空きが確認できました。
        </p>
        <p>{WATCH_AVAILABILITY_CAVEAT}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} asChild>
            <Link to={`/domains/new?domain=${encodeURIComponent(watch.domainName)}`}>
              購入手続きへ進む
            </Link>
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
            空き待ちを解除
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * 空き待ちの一覧: the names still being checked (and the ones whose 30-day
 * window ran out). `available` rows are absent on purpose — they are already
 * the banner above; `fulfilled` rows too — the domain list itself is the
 * better answer once the member holds the name.
 */
function WatchSection({
  watches,
  busy,
  onCancel,
}: {
  watches: DomainWatch[]
  busy: boolean
  onCancel: (domainName: string) => void
}) {
  const rows = watches.filter((watch) => watch.state === 'watching' || watch.state === 'expired')
  if (rows.length === 0) return null
  return (
    <section aria-label="空き待ち通知">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-base font-semibold">空き待ち通知</h2>
        <p className="text-[13px] text-muted-foreground">
          購入できる状態を確認でき次第、ここでお知らせします
        </p>
      </div>
      <Card className="py-0">
        <ul className="divide-y divide-border">
          {rows.map((watch) => (
            <li
              key={watch.domainName}
              className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <span className="font-mono text-sm font-semibold">{watch.domainName}</span>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {watch.state === 'expired'
                    ? '空き待ちの期限が切れました。検索画面からもう一度登録できます。'
                    : `空きを確認しています（${formatDateJa(watch.expiresAt)} まで）`}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                disabled={busy}
                onClick={() => onCancel(watch.domainName)}
              >
                解除
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}

function ListSkeleton() {
  return (
    <Card className="py-0">
      <div className="divide-y divide-border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 px-5 py-4">
            <div className="flex-1">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-2 h-4 w-24" />
            </div>
            <Skeleton className="hidden h-8 w-52 sm:block" />
          </div>
        ))}
      </div>
    </Card>
  )
}

export function MyPage() {
  const [domains, setDomains] = useState<MyDomainSummary[] | null>(null)
  const [transferRequests, setTransferRequests] = useState<Transfer[]>([])
  const [watches, setWatches] = useState<DomainWatch[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  const [approveTarget, setApproveTarget] = useState<Transfer | null>(null)
  const { state: authState } = useAuth()
  const uid = authState.status === 'authenticated' ? authState.user.id : null

  const load = useCallback(async (signal?: AbortSignal) => {
    // Best-effort: the emulator never fires the 5-minute pollWorker schedule,
    // so a transfer-out request would otherwise never reach Firestore for
    // listTransfers to find. A drain failure must not block the page or the
    // domain list behind it — swallow it and fall through to the real load.
    // The same drain also runs the watch sweep server-side (throttled), so
    // the watches fetched below are as fresh as the emulator can make them.
    // 同じ画面の TransferInSection も同じドレインを待つ（api/transferApi.ts の
    // ensureTransferNotificationsDrained）。片方だけがドレイン後の状態を読むと、
    // 1 画面のなかで移管の状態が食い違う。
    await ensureTransferNotificationsDrained(signal)
    if (signal?.aborted) return
    try {
      const [domainsResult, transferRequestsResult, watchesResult] = await Promise.all([
        fetchMyDomains(signal),
        fetchTransferOutRequests(signal),
        fetchDomainWatches(signal),
      ])
      setDomains(domainsResult.domains)
      setTransferRequests(transferRequestsResult)
      setWatches(watchesResult)
      setLoadError(null)
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(messageForError(error))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount: every setState happens after an await.
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  // The periodic tick exists solely so an incoming transfer-out request
  // (§6.6.1: 20-minute auto-approve) shows up without a manual reload, so it
  // refreshes only the transfer list. Re-fetching the whole domain list every
  // 30 seconds multiplied Firestore reads by the member's domain count; the
  // domain list is loaded on mount and after each user action instead. A
  // failed background refresh keeps the last known list — the initial load
  // and user actions surface their own errors.
  const refreshTransferRequests = useCallback(async () => {
    // 上の load() と同じ共有ドレインを使う。ここだけ生の drainTransferNotifications
    // を呼ぶと、30 秒ごとの背景更新が同居する移管IN区画と別々にレジストリを叩き、
    // ensureTransferNotificationsDrained が直した「1 画面で移管の状態が食い違う」が
    // 戻ってくる（api/transferApi.ts の説明を見ること）。
    await ensureTransferNotificationsDrained()
    try {
      setTransferRequests(await fetchTransferOutRequests())
    } catch {
      // Background refresh only: stale data beats an error banner that would
      // flap on every transient failure.
    }
  }, [])

  // `busyRef` mirrors `busy` so the effects below read live state instead of
  // the value captured when their closure was created.
  const busyRef = useRef(busy)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  // ⚠️ §6.6.1: an unanswered transfer-out request auto-approves after 20
  // minutes; polling this often is how a member sees an incoming request
  // without manually reloading the page. The interval itself is
  // TRANSFER_REFRESH_MS in api/transferApi.ts, shared with TransferInSection
  // so the two halves of this screen never drift apart. The onSnapshot
  // subscription below is the primary path in production - this interval is
  // the fallback for environments where it doesn't fire (denied rules,
  // offline, or the emulator besides).
  useEffect(() => {
    const id = setInterval(() => {
      // Skip a tick while an approve/reject action is in flight so the
      // periodic refresh cannot clobber its in-progress state.
      if (busyRef.current) return
      void refreshTransferRequests()
    }, TRANSFER_REFRESH_MS)
    return () => clearInterval(id)
  }, [refreshTransferRequests])

  // §6.6.1: an incoming/settled transfer must show up without a manual
  // reload, in every environment. Rather than poll a callable, subscribe to
  // the `transfers` Firestore doc(s) this member owns (firestore.rules:
  // owner-only read) purely as a change signal - the screen still renders
  // from the callables' DTOs via `load()`, never straight off the snapshot.
  // The subscription's own first emission is skipped: the mount-time `load()`
  // effect above already covers the initial render, so re-running it here
  // too would just double the first fetch.
  useEffect(() => {
    if (!uid) return
    let skippedInitial = false
    let unsubscribe: (() => void) | undefined
    try {
      const transfersQuery = query(collection(firestore, 'transfers'), where('uid', '==', uid))
      unsubscribe = onSnapshot(
        transfersQuery,
        () => {
          if (!skippedInitial) {
            skippedInitial = true
            return
          }
          if (busyRef.current) return
          void load()
        },
        () => {
          // permission-denied (stale rules), offline, etc.: the listener is
          // only a change signal, so drop it and let the interval poll cover.
          unsubscribe?.()
          unsubscribe = undefined
        },
      )
    } catch {
      // A rules-denied, offline, or (in tests) mocked/uninitialized Firestore
      // must not break the page - the mount-time load() above already covers
      // the initial render, and the interval above covers the rest.
    }
    return () => unsubscribe?.()
  }, [uid, load])

  async function runAction(action: () => Promise<void>, successNotice: string) {
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      await action()
      await load()
      setNotice(successNotice)
    } catch (error) {
      setActionError(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  // 使用不可 (lifecycle "gone"): the member no longer holds these names —
  // transferred away, or purged after the redemption window. They must not
  // count as アクティブ, must not link anywhere, and offer no actions: the
  // same name may already belong to someone else (spec 7.3).
  const gone = domains?.filter((domain) => domain.lifecycle === 'gone') ?? []
  const held = domains?.filter((domain) => domain.lifecycle !== 'gone') ?? []
  const active = held.filter((domain) => !isEnding(domain))
  const ending = held.filter(isEnding)

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">マイページ</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            保有しているドメインの状態確認・期限の管理・各種設定ができます。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* docs/仕様/auth.md §4.8: プロフィール表示・編集 & 退会への導線。 */}
          <Button variant="outline" asChild>
            <Link to="/mypage/profile">
              <UserRound />
              プロフィール・退会
            </Link>
          </Button>
          {/* §6.2.1 入口②「他社から引っ越してくる」の通常モード版導線 (§6.6.2) */}
          <Button variant="outline" asChild>
            <Link to="/mypage/transfer">
              <ArrowLeftRight />
              他社から移管する
            </Link>
          </Button>
        </div>
      </header>

      {loadError ? (
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
      ) : null}

      {actionError ? <StatusBanner tone="error">{actionError}</StatusBanner> : null}

      {notice ? <StatusBanner tone="success">{notice}</StatusBanner> : null}

      {transferRequests.map((request) => (
        <TransferRequestAlert
          key={request.domainName}
          notice={request}
          busy={busy}
          onApprove={() => setApproveTarget(request)}
          onReject={() =>
            void runAction(async () => {
              await respondTransferOut(request.domainName, 'reject')
            }, `${request.domainName} の移管申請を拒否しました。`)
          }
        />
      ))}

      {watches
        .filter((watch) => watch.state === 'available')
        .map((watch) => (
          <WatchAvailableAlert
            key={watch.domainName}
            watch={watch}
            busy={busy}
            onCancel={() =>
              void runAction(async () => {
                await cancelDomainWatch(watch.domainName)
              }, `${watch.domainName} の空き待ちを解除しました。`)
            }
          />
        ))}

      <TransferInSection />

      {domains === null && !loadError ? <ListSkeleton /> : null}

      {domains !== null && domains.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Globe className="size-8 text-ink-faint" />
            <p className="font-semibold">まだドメインがありません</p>
            <p className="text-[13px] text-muted-foreground">
              最初のドメインを検索して、あなたのドメインを取得しましょう。
            </p>
            <Button asChild className="mt-1">
              <Link to="/">ドメインを探す</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <DomainSection
        title="アクティブ"
        description="利用中のドメイン"
        domains={active}
        onRestore={setRestoreTarget}
      />
      <DomainSection
        title="ライフサイクル終盤"
        description="手続き中・まもなく終了するドメイン"
        domains={ending}
        onRestore={setRestoreTarget}
      />

      <WatchSection
        watches={watches}
        busy={busy}
        onCancel={(domainName) =>
          void runAction(async () => {
            await cancelDomainWatch(domainName)
          }, `${domainName} の空き待ちを解除しました。`)
        }
      />

      <GoneSection domains={gone} />

      {/* 復旧の確認 (FIG.4: pendingDelete → restore) */}
      <Dialog open={restoreTarget !== null} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ドメインを復旧しますか？</DialogTitle>
            <DialogDescription>
              <span className="font-mono font-semibold">{restoreTarget}</span>{' '}
              の廃止手続きを取り消して、元の状態に戻します。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setRestoreTarget(null)}>
              キャンセル
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const name = restoreTarget
                if (!name) return
                setRestoreTarget(null)
                void runAction(async () => {
                  await restoreMyDomain(name)
                }, `${name} を復旧しました。`)
              }}
            >
              <Undo2 />
              復旧する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 移管承認の確認 (irreversible: the domain leaves this service) */}
      <Dialog open={approveTarget !== null} onOpenChange={(open) => !open && setApproveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移管を承認しますか？</DialogTitle>
            <DialogDescription>
              承認すると <span className="font-mono font-semibold">{approveTarget?.domainName}</span>{' '}
              は移管先レジストラの管理になり、このサービスの一覧から消えます。この操作は取り消せません。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setApproveTarget(null)}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = approveTarget
                if (!target) return
                setApproveTarget(null)
                void runAction(async () => {
                  await respondTransferOut(target.domainName, 'approve')
                }, `${target.domainName} の移管を承認しました。`)
              }}
            >
              承認して移管する
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
