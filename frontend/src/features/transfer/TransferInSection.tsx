/**
 * マイページの移管IN進捗区画 (§6.6.2 step 4: pendingTransfer の進捗表示 / FIG.9).
 *
 * Self-contained data loading on purpose: MyPage's own load() stays about
 * domains + transfer-OUT notices, and this section can be dropped next to it
 * without touching that logic. Renders nothing while empty — most users have
 * no transfer in flight.
 *
 * ⚠️ The real `listTransfers` answers with PENDING transfers only, so a
 * settled one simply drops out of the list. FIG.9 asks for a result row that
 * stays until the user closes it, so this section asks `getTransferStatus`
 * about every watched domain that is no longer pending (transferWatchlist.ts
 * explains the bookkeeping).
 *
 * ⚠️ 読む前に必ず `ensureTransferNotificationsDrained()` を待つ（2026-08-28）。
 * エミュレータでは 5 分周期の `pollWorker` が動かないので、移管の結果は誰かが
 * `drainPollQueue` を叩いた瞬間にしか Firestore へ入らない。以前ここだけが
 * ドレインを待たずに読んでいたため、同じ画面のドメイン一覧が「移管済み」を
 * 出しているのにこの区画は「承認待ち」のまま、という食い違いが起き、
 * リロードのたびに状態が変わって見えていた。ドレインは共有されるので、
 * マイページ本体と 2 度叩くことはない。
 *
 * 再取得の間隔もマイページ本体と同じ（`TRANSFER_REFRESH_MS`）。片方だけが
 * 30 秒ごとに新しくなると、待っているあいだに同じ食い違いが戻ってくる。
 */
import { ArrowLeftRight, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { messageForError } from '../../api/apiError'
import {
  cancelTransferIn,
  ensureTransferNotificationsDrained,
  fetchTransferInRequests,
  fetchTransferStatus,
  isSettledTransfer,
  transferPresentation,
  TRANSFER_REFRESH_MS,
  type Transfer,
} from '../../api/transferApi'
import { formatDateTimeJa, REGISTRY_LABELS, STATUS_TONE_CLASSES } from '../mypage/domainDisplay'
import {
  TRANSFER_IN_APPROVED_NOTE,
  TRANSFER_IN_CANCEL_CONFIRM,
  TRANSFER_IN_REJECTED_NOTE,
  transferInAutoApproveNote,
} from './transferMessages'
import { unwatchTransferIn, watchTransferIn, watchedTransferIns } from './transferWatchlist'

/** 結果行の補足説明。pending は行そのものが説明なので付けない (§3.5). */
const SETTLED_NOTES: Partial<Record<Transfer['state'], string>> = {
  completed: TRANSFER_IN_APPROVED_NOTE,
  rejected: TRANSFER_IN_REJECTED_NOTE,
}

function RequestRow({
  request,
  busy,
  onCancel,
  onClose,
}: {
  request: Transfer
  busy: boolean
  onCancel: () => void
  onClose: () => void
}) {
  const pending = request.state === 'pending'
  const presentation = transferPresentation(request)
  const note = pending ? null : SETTLED_NOTES[request.state]
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-semibold">{request.domainName}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={STATUS_TONE_CLASSES[presentation.tone]}>
            {presentation.label}
          </Badge>
          <span className="text-xs text-ink-faint">
            {REGISTRY_LABELS[request.registry] ?? request.registry}
            {request.requestedAt ? `・${formatDateTimeJa(request.requestedAt)} 申請` : null}
          </span>
        </div>
        {/* §6.6.1: 移管元が黙っていても20分で自動承認される — 待てばよいと伝える. */}
        {pending && request.autoApproveAt ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            {transferInAutoApproveNote(formatDateTimeJa(request.autoApproveAt))}
          </p>
        ) : null}
        {note ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{note}</p>
        ) : null}
      </div>
      <div className="shrink-0">
        {pending ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            申請を取り下げる
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            <X />
            閉じる
          </Button>
        )}
      </div>
    </li>
  )
}

export function TransferInSection() {
  const [pending, setPending] = useState<Transfer[]>([])
  const [settled, setSettled] = useState<Transfer[]>([])
  /* load() を `settled` に依存させない（依存させると結果行が増えるたびに
     コールバックの同一性が変わり、下の定期取得が張り直される）。 */
  const settledRef = useRef<Transfer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<Transfer | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      await ensureTransferNotificationsDrained(signal)
      if (signal?.aborted) return
      const requests = await fetchTransferInRequests(signal)
      const stillPending = new Set(requests.map((request) => request.domainName))
      // A request this tab did not start (or started before a reload) enters
      // the watchlist the first time it is seen pending, so its outcome is
      // still reported once it leaves the list.
      for (const name of stillPending) watchTransferIn(name)
      /* ⚠️ すでに結果行として出しているものは二度と聞かない。決着した記録は
         もう変わらないのに、30 秒ごとに 1 行 1 回の `getTransferStatus`
         （レジストリ由来の読み取り）を、ユーザーが「閉じる」を押すまで永久に
         投げ続けることになる。聞くのは「監視中なのに pending から消えたもの」
         のうち、まだ結果を持っていないものだけ。 */
      const answered = new Set(settledRef.current.map((row) => row.domainName))
      const dropped = watchedTransferIns().filter(
        (name) => !stillPending.has(name) && !answered.has(name),
      )

      // Each dropped domain settled while we were not looking; ask how. A read
      // that fails must not take the whole section down — the transfer is over
      // either way, and the owned-domain list is the other half of the answer.
      const results = await Promise.all(
        dropped.map((name) => fetchTransferStatus(name, signal).catch(() => null)),
      )
      if (signal?.aborted) return
      const finished = results.filter(
        (transfer): transfer is Transfer =>
          transfer !== null && isSettledTransfer(transfer) && transfer.direction === 'in',
      )

      setPending(requests)
      setSettled((previous) => [
        ...previous.filter(
          (row) => !finished.some((transfer) => transfer.domainName === row.domainName),
        ),
        ...finished,
      ])
      setError(null)
    } catch (loadError) {
      if (signal?.aborted) return
      setError(messageForError(loadError))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount: every setState happens after an await.
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    settledRef.current = settled
  }, [settled])

  // `busyRef` mirrors `busy` so the interval tick below reads live state
  // instead of the value captured when the interval closure was created
  // (same shape as MyPage.tsx).
  const busyRef = useRef(busy)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  /* マイページ本体と同じ周期で追いつく。⚠️ 取り下げの処理中 (busy) は見送る —
     進行中の操作を定期取得が上書きしないように。

     ⚠️ 待っているものが何も無いときはタイマーを張らない。移管INの申請は
     この画面からしか始まらず、始めた時点で load() が走るので、pending も
     結果行も無い人（＝大多数）に 30 秒ごとの `listTransfers` を撃たせる
     理由が無い。 */
  const watching = pending.length > 0 || settled.length > 0
  useEffect(() => {
    if (!watching) return
    const id = setInterval(() => {
      if (busyRef.current) return
      void load()
    }, TRANSFER_REFRESH_MS)
    return () => clearInterval(id)
  }, [load, watching])

  /** 取り下げ (§6.6.1). The member already knows how it ended: no result row. */
  async function cancel(domainName: string) {
    setBusy(true)
    setError(null)
    try {
      await cancelTransferIn(domainName)
      unwatchTransferIn(domainName)
      await load()
    } catch (actionError) {
      setError(messageForError(actionError))
    } finally {
      setBusy(false)
    }
  }

  /** 結果行を閉じる: no backend call — the record is already settled there. */
  function closeResult(domainName: string) {
    unwatchTransferIn(domainName)
    setSettled((previous) => previous.filter((row) => row.domainName !== domainName))
  }

  const rows = [...pending, ...settled]

  // Empty and error-free: most users have no transfer in flight — stay silent.
  if (rows.length === 0 && !error) return null

  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          <ArrowLeftRight className="size-4 text-primary" />
          移管の手続き中
        </h2>
        <p className="text-[13px] text-muted-foreground">他社から引っ越してくるドメイン</p>
      </div>
      {error ? <p className="mb-3 text-[13px] font-medium text-destructive">{error}</p> : null}
      {rows.length > 0 ? (
        <Card className="py-0">
          <ul className="divide-y divide-border">
            {rows.map((request) => (
              <RequestRow
                key={request.domainName}
                request={request}
                busy={busy}
                onCancel={() => setCancelTarget(request)}
                onClose={() => closeResult(request.domainName)}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {/* 取り下げの確認 (§6.6.1: gaining は承認前なら cancel できる) */}
      <Dialog open={cancelTarget !== null} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移管の申請を取り下げますか？</DialogTitle>
            <DialogDescription>
              <span className="font-mono font-semibold">{cancelTarget?.domainName}</span>{' '}
              — {TRANSFER_IN_CANCEL_CONFIRM}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setCancelTarget(null)}>
              戻る
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = cancelTarget
                if (!target) return
                setCancelTarget(null)
                void cancel(target.domainName)
              }}
            >
              申請を取り下げる
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
