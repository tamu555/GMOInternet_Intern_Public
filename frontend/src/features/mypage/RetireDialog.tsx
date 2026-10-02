/**
 * 「もう使わない」フロー (spec §6.5 確定仕様):
 *
 *   ├─ 期限まで使って、そのあと自動で終わりにする ← 推奨（自動更新OFF）
 *   └─ 今すぐ削除する ← 猶予期間の説明 + 影響明示を必須表示
 *
 * 即時削除は多くの場合ユーザーにとって損 (期限まで使えるのに前倒しで消える)
 * なので、推奨側を先頭・強調で出す。削除確定前の影響明示は必須 (§6.5).
 */
import { AlertTriangle, CalendarClock, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDateJa } from './domainDisplay'
import {
  DELETE_IMPACT_WARNING,
  GRACE_PERIOD_EXPLANATION,
  RETIRE_KEEP_DESCRIPTION,
  RETIRE_KEEP_LABEL,
  RETIRE_NOW_DESCRIPTION,
  RETIRE_NOW_LABEL,
} from './mypageMessages'

type RetireDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  domainName: string
  exDate: string
  busy: boolean
  /** 推奨: 自動更新OFF (実体は期限日のアプリ側バッチ delete, TBD #15). */
  onKeepUntilExpiry: () => void
  onDeleteNow: () => void
}

export function RetireDialog({ open, onOpenChange, ...bodyProps }: RetireDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix unmounts DialogContent while closed, so the body remounts on
          every open with step='choose' - no reset effect needed. */}
      <DialogContent className="sm:max-w-md">
        <RetireDialogBody onOpenChange={onOpenChange} {...bodyProps} />
      </DialogContent>
    </Dialog>
  )
}

function RetireDialogBody({
  onOpenChange,
  domainName,
  exDate,
  busy,
  onKeepUntilExpiry,
  onDeleteNow,
}: Omit<RetireDialogProps, 'open'>) {
  const [step, setStep] = useState<'choose' | 'confirm-delete'>('choose')

  return (
    <>
        {step === 'choose' ? (
          <>
            <DialogHeader>
              <DialogTitle>このドメインをもう使わない</DialogTitle>
              <DialogDescription>
                <span className="font-mono font-semibold">{domainName}</span>{' '}
                の終わり方を選んでください。
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={onKeepUntilExpiry}
                className="cursor-pointer rounded-lg border border-primary/40 bg-grass-1/60 p-4 text-left transition-colors hover:border-primary disabled:opacity-50"
              >
                <span className="flex items-center gap-2 font-semibold">
                  <CalendarClock className="size-4 text-primary" />
                  {RETIRE_KEEP_LABEL}
                  <Badge className="ml-1">推奨</Badge>
                </span>
                <span className="mt-1 block text-[13px] text-muted-foreground">
                  {RETIRE_KEEP_DESCRIPTION}（期限: {formatDateJa(exDate)}）
                </span>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => setStep('confirm-delete')}
                className="cursor-pointer rounded-lg border border-border p-4 text-left transition-colors hover:border-destructive disabled:opacity-50"
              >
                <span className="flex items-center gap-2 font-semibold text-destructive">
                  <Trash2 className="size-4" />
                  {RETIRE_NOW_LABEL}
                </span>
                <span className="mt-1 block text-[13px] text-muted-foreground">{RETIRE_NOW_DESCRIPTION}</span>
              </button>
            </div>

            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                キャンセル
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>本当に今すぐ削除しますか？</DialogTitle>
              <DialogDescription>
                <span className="font-mono font-semibold">{domainName}</span> を廃止します。
              </DialogDescription>
            </DialogHeader>

            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{DELETE_IMPACT_WARNING}</AlertTitle>
              <AlertDescription>
                <p>{GRACE_PERIOD_EXPLANATION}</p>
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setStep('choose')}>
                戻る
              </Button>
              <Button variant="destructive" disabled={busy} onClick={onDeleteNow}>
                {busy ? '削除中…' : '今すぐ削除する'}
              </Button>
            </DialogFooter>
          </>
        )}
    </>
  )
}
