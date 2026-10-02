/**
 * マイページ：ドメイン詳細 (docs/api-flow-diagrams.html FIG.10).
 *
 * Every operation card maps onto one row of FIG.10:
 *   期限と更新   → POST /api/orders (kind=renew) + autoRenew flag (§6.4)
 *   DNS         → PUT nameservers (§6.3.3 警告必須) + /dns へのリンク
 *   保護・ロック → client*Prohibited (ドメインプロテクションのミニ版 §6.1)
 *   移管        → authInfo マスク+コピーのみ (§7.3) + rotate-auth-info
 *   もう使わない → §6.5 の2択 (推奨=期限まで使う) / pendingDelete なら復旧
 *
 * §6.4/TBD #15: the auto-renew OFF toggle is an app-side flag whose real
 * effect is the batch delete at exDate - the label text says so, so the UI
 * does not lie about what the registry does (§3.6: it always auto-renews).
 */
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  CalendarClock,
  CreditCard,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ApiError, messageForError } from '../../api/apiError'
import { StatusBanner } from '../../components/StatusBanner'
import {
  deleteMyDomain,
  fetchMyDomain,
  locksFromStatuses,
  restoreMyDomain,
  rotateAuthInfo,
  updateMyDomain,
  type DomainLocks,
  type MyDomainDetail,
} from '../../api/myDomainsApi'
import { createOrder } from '../../api/ordersApi'
import { AuthInfoMasked } from '../orders/AuthInfoMasked'
import {
  canRestore,
  daysLeftUntil,
  daysUntil,
  expiryIndicatorClass,
  expiryProgressPercent,
  formatDateJa,
  REGISTRY_LABELS,
} from './domainDisplay'
import {
  AUTO_RENEW_OFF_NOTE,
  INACTIVE_NOTICE,
  RESTORE_WINDOW_ENDED_LABEL,
  RESTORE_WINDOW_ENDED_NOTE,
} from './mypageMessages'
import { NameserverDialog } from './NameserverDialog'
import { RenewDialog } from './RenewDialog'
import { RetireDialog } from './RetireDialog'
import { StatusBadges } from './StatusBadges'

const LOCK_ROWS: { key: keyof DomainLocks; label: string; description: string }[] = [
  { key: 'transfer', label: '移管ロック', description: '他社への移管（引っ越し）申請をブロックします。' },
  { key: 'update', label: '変更ロック', description: 'ネームサーバーなどの設定変更をブロックします。' },
  { key: 'delete', label: '削除ロック', description: '誤操作によるドメインの廃止をブロックします。' },
  { key: 'renew', label: '更新ロック', description: '期限の更新（延長）をブロックします。' },
]

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

export function DomainDetailPage() {
  const { domainName = '' } = useParams()
  const navigate = useNavigate()
  const [domain, setDomain] = useState<MyDomainDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renewOpen, setRenewOpen] = useState(false)
  const [nsOpen, setNsOpen] = useState(false)
  const [retireOpen, setRetireOpen] = useState(false)

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await fetchMyDomain(domainName, signal)
        setDomain(result.domain)
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

  async function runAction(action: () => Promise<MyDomainDetail | null>, successNotice: string | null) {
    setBusy(true)
    setActionError(null)
    setNotice(null)
    try {
      const updated = await action()
      if (updated) setDomain(updated)
      if (successNotice) setNotice(successNotice)
    } catch (error) {
      setActionError(messageForError(error))
    } finally {
      setBusy(false)
    }
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

  if (!domain) {
    return (
      <div className="w-full">
        <DetailSkeleton />
      </div>
    )
  }

  const locks = locksFromStatuses(domain.statuses)
  const pendingDelete = domain.statuses.includes('pendingDelete')
  const pendingTransfer = domain.statuses.includes('pendingTransfer')
  const lifecycleLocked = pendingDelete || pendingTransfer
  const inactive = domain.statuses.includes('inactive')
  const remaining = daysUntil(domain.exDate)
  // §6.5 / RGP: redemptionPeriod の間だけが「戻せる」期間。過ぎたあとの
  // pendingDelete では復旧を勧めず、何が起きるのかだけを伝える.
  const restorable = canRestore(domain)
  const restorableDays = domain.restorableUntil ? daysLeftUntil(domain.restorableUntil) : null

  return (
    <div className="flex w-full flex-col gap-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/mypage">
            <ArrowLeft />
            ドメイン一覧へ
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-mono text-2xl font-bold tracking-tight">{domain.name}</h1>
          <Badge variant="outline">{REGISTRY_LABELS[domain.registry] ?? domain.registry}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusBadges
            statuses={domain.statuses}
            rgpStatuses={domain.rgpStatuses}
            autoRenewCancelableUntil={domain.autoRenewCancelableUntil}
          />
        </div>
      </div>

      {actionError ? <StatusBanner tone="error">{actionError}</StatusBanner> : null}

      {notice ? <StatusBanner tone="success">{notice}</StatusBanner> : null}

      {/* Titled, multi-line notices with their own actions — deliberate raw-Alert
          usage; StatusBanner (DESIGN_SYSTEM.md) covers one-line messages only. */}
      {pendingDelete ? (
        <Alert variant="warning">
          <Trash2 />
          <AlertTitle>
            {restorable
              ? `解約手続き中です${restorableDays !== null ? `（あと${restorableDays}日は戻せます）` : ''}`
              : RESTORE_WINDOW_ENDED_LABEL}
          </AlertTitle>
          <AlertDescription>
            {restorable ? (
              <>
                <p>猶予期間内なら復旧して、元の状態に戻せます。期間を過ぎると第三者が取得できる状態になります。</p>
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      const result = await restoreMyDomain(domain.name)
                      return result.domain
                    }, 'ドメインを復旧しました。')
                  }
                >
                  <Undo2 />
                  復旧する
                </Button>
              </>
            ) : (
              <p>{RESTORE_WINDOW_ENDED_NOTE}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {pendingTransfer ? (
        <Alert variant="info">
          <ArrowLeftRight />
          <AlertTitle>引っ越しの手続き中です</AlertTitle>
          <AlertDescription>
            <p>移管（pendingTransfer）が進行中のため、設定の変更は一時的にできません。</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---- 期限と更新 (§6.4) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="size-4 text-primary" />
            期限と更新
          </CardTitle>
          <CardDescription>
            登録日 {formatDateJa(domain.registeredAt)} ・ 有効期限 {formatDateJa(domain.exDate)}
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              disabled={busy || lifecycleLocked || locks.renew}
              onClick={() => setRenewOpen(true)}
            >
              <RefreshCw />
              今すぐ更新する
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">残り期間</span>
              <span className={`font-bold ${remaining <= 30 ? 'text-destructive' : ''}`}>
                {remaining >= 0 ? `${remaining}日` : '期限切れ'}
              </span>
            </div>
            <Progress
              value={expiryProgressPercent(domain.exDate)}
              className="mt-2"
              indicatorClassName={expiryIndicatorClass(remaining)}
            />
          </div>

          <Separator />

          {/* §6.4: 自動更新の状態は残り日数と同じ視覚的比重で表示する */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">自動更新</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{AUTO_RENEW_OFF_NOTE}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              <span className={`text-sm font-bold ${domain.autoRenew ? 'text-primary' : 'text-orange-strong'}`}>
                {domain.autoRenew ? 'ON' : 'OFF'}
              </span>
              <Switch
                aria-label="自動更新"
                checked={domain.autoRenew}
                disabled={busy || pendingDelete}
                onCheckedChange={(checked) =>
                  void runAction(async () => {
                    const result = await updateMyDomain(domain.name, { autoRenew: checked })
                    return result.domain
                  }, `自動更新を${checked ? 'ON' : 'OFF'}にしました。`)
                }
              />
            </div>
          </div>

          {/* §6.4: 支払い方法の状態はドメインを失う原因の筆頭なので常時表示 */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <CreditCard className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">支払い方法</span>
            </div>
            {domain.paymentMethod === 'valid' ? (
              <Badge variant="secondary" className="text-primary">
                有効
              </Badge>
            ) : (
              <Badge variant="destructive">期限切れ</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---- DNS (§6.3) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4 text-primary" />
            ドメインをつなぐ
          </CardTitle>
          <CardDescription>
            このドメイン名を打った人にホームページを表示したり、このドメインでメールを受け取れるようにする設定です。まだ何も用意していない方には、先に何を用意すればよいかからご案内します。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {inactive ? <StatusBanner tone="info">{INACTIVE_NOTICE}</StatusBanner> : null}
          {domain.nameservers.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {domain.nameservers.map((host) => (
                <li key={host} className="rounded-md bg-muted px-3 py-2 font-mono text-[13px]">
                  {host}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              まだ設定していません。取得したばかりのドメインはこの状態が普通です。
            </p>
          )}
          {/* One front door, on purpose. This card used to offer ネームサーバーを変更
              and DNSレコードを設定 as two equal buttons, so the beginner picked
              between delegation models HERE — with no help — and only then met the
              DNS page that explains the choice. The help was in the second place
              they were asked, not the place they committed, and the wrong branch
              (NS) is the one that can stop their mail (§6.3.3e). The setup page now
              owns the whole decision, its evidence-based wording and its
              「分からない」 escape; direct NS replacement stays for people who
              already know they want it. */}
          <div className="flex flex-col items-start gap-3">
            <Button asChild>
              <Link to={`/domains/${encodeURIComponent(domain.name)}/dns`}>つなぐ設定をはじめる</Link>
            </Button>
            {/* The condition comes before the control it qualifies: read in the
                other order, the caption dangles under a button the reader has
                already decided about. px-0 keeps the ghost button's label on the
                same left edge as the primary above it. */}
            <div className="flex flex-col items-start gap-0.5">
              <p className="text-xs text-muted-foreground">
                ネームサーバーを渡されていて、直接入れ替えたい方は
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 py-0"
                disabled={busy || lifecycleLocked || locks.update}
                onClick={() => setNsOpen(true)}
              >
                ネームサーバーを変更
              </Button>
            </div>
          </div>
          {locks.update ? (
            <p className="text-xs text-muted-foreground">変更ロック中のため、ネームサーバーは変更できません。</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---- 保護・ロック (§6.1: ドメインプロテクションのミニ版) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            保護・ロック設定
          </CardTitle>
          <CardDescription>
            意図しない移管・変更・削除・更新を防ぎます（レジストリの client* ステータスを設定します）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {LOCK_ROWS.map((row, index) => (
            <div key={row.key}>
              {index > 0 ? <Separator className="my-2.5" /> : null}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold">{row.label}</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{row.description}</p>
                </div>
                <Switch
                  aria-label={row.label}
                  checked={locks[row.key]}
                  disabled={busy || lifecycleLocked}
                  onCheckedChange={(checked) =>
                    void runAction(async () => {
                      const result = await updateMyDomain(domain.name, { locks: { [row.key]: checked } })
                      return result.domain
                    }, `${row.label}を${checked ? '有効' : '解除'}にしました。`)
                  }
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ---- 移管 (§6.6 / §7.3) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            移管用の認証コード（authInfo）
          </CardTitle>
          <CardDescription>
            他社レジストラへ移管（引っ越し）するときに、移管先で入力するコードです。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <AuthInfoMasked authInfo={domain.authInfo} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || lifecycleLocked}
              onClick={() =>
                void runAction(async () => {
                  const result = await rotateAuthInfo(domain.name)
                  // The rotation answer is the only copy of the new code the
                  // member will ever be shown (§7.3), so put it straight on
                  // the clipboard. When the browser refuses (no permission,
                  // background tab), the copy button next to the mask still
                  // has the value — the notice says which happened.
                  let copied = false
                  try {
                    await navigator.clipboard.writeText(result.authInfo)
                    copied = true
                  } catch {
                    copied = false
                  }
                  setNotice(
                    copied
                      ? '認証コードを再生成してコピーしました。古いコードは使えなくなります。'
                      : '認証コードを再生成しました。「コピー」ボタンからコピーしてください。古いコードは使えなくなります。',
                  )
                  return { ...domain, authInfo: result.authInfo }
                }, null)
              }
            >
              <RefreshCw />
              再生成する
            </Button>
            {locks.transfer ? (
              <span className="text-xs text-muted-foreground">
                移管ロック中です。移管するには先にロックを解除してください。
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ---- もう使わない (§6.5) ---- */}
      {!pendingDelete ? (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-4" />
              このドメインをもう使わない
            </CardTitle>
            <CardDescription>
              期限まで使って自動で終わりにするか、今すぐ削除するかを選べます。
            </CardDescription>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:border-destructive hover:text-destructive"
                disabled={busy || pendingTransfer || locks.delete}
                onClick={() => setRetireOpen(true)}
              >
                手続きへ
              </Button>
            </CardAction>
          </CardHeader>
          {locks.delete ? (
            <CardContent>
              <p className="text-xs text-muted-foreground">削除ロック中のため、廃止手続きはできません。</p>
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <RenewDialog
        open={renewOpen}
        onOpenChange={setRenewOpen}
        domainName={domain.name}
        exDate={domain.exDate}
        busy={busy}
        onSubmit={(years) => {
          void runAction(async () => {
            const order = await createOrder({
              kind: 'renew',
              domainName: domain.name,
              years,
              // The expiry the member just confirmed against — the renew
              // idempotency fingerprint anchors on it (ordersApi.ts).
              currentExDate: domain.exDate,
            })
            // FIG.10: hand off to the FIG.1 order-status screen (poll → done).
            navigate(`/orders/${encodeURIComponent(order.id)}`)
            return null
          }, null)
        }}
      />

      <NameserverDialog
        open={nsOpen}
        onOpenChange={setNsOpen}
        domainName={domain.name}
        nameservers={domain.nameservers}
        busy={busy}
        onSubmit={(nameservers) => {
          void runAction(async () => {
            const result = await updateMyDomain(domain.name, { nameservers })
            setNsOpen(false)
            return result.domain
          }, 'ネームサーバーを変更しました。反映まで時間がかかる場合があります。')
        }}
      />

      <RetireDialog
        open={retireOpen}
        onOpenChange={setRetireOpen}
        domainName={domain.name}
        exDate={domain.exDate}
        busy={busy}
        onKeepUntilExpiry={() => {
          void runAction(async () => {
            const result = await updateMyDomain(domain.name, { autoRenew: false })
            setRetireOpen(false)
            return result.domain
          }, '自動更新をOFFにしました。期限まで使えて、そのあと自動で終了します。')
        }}
        onDeleteNow={() => {
          void runAction(async () => {
            const result = await deleteMyDomain(domain.name)
            setRetireOpen(false)
            return result.domain
          }, 'ドメインを廃止しました。猶予期間内なら復旧できます。')
        }}
      />
    </div>
  )
}
