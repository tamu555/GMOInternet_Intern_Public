/**
 * ネームサーバ変更ダイアログ (FIG.10 NS → registry domain:update).
 * §6.3.3(e): the warning about existing records AND mail stopping is a
 * spec-mandated fixture of this dialog, not decoration.
 */
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { NS_CHANGE_WARNING } from './mypageMessages'

type NameserverDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  domainName: string
  nameservers: string[]
  busy: boolean
  onSubmit: (nameservers: string[]) => void
}

export function NameserverDialog({ open, onOpenChange, ...bodyProps }: NameserverDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix unmounts DialogContent while closed, so the body's state is
          freshly initialized from props on every open - no reset effect. */}
      <DialogContent className="sm:max-w-md">
        <NameserverDialogBody onOpenChange={onOpenChange} {...bodyProps} />
      </DialogContent>
    </Dialog>
  )
}

function NameserverDialogBody({
  onOpenChange,
  domainName,
  nameservers,
  busy,
  onSubmit,
}: Omit<NameserverDialogProps, 'open'>) {
  const [hosts, setHosts] = useState<string[]>([nameservers[0] ?? '', nameservers[1] ?? ''])
  const [fieldError, setFieldError] = useState<string | null>(null)

  function handleSubmit() {
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
    onSubmit(cleaned)
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>ネームサーバーを変更する</DialogTitle>
          <DialogDescription>
            <span className="font-mono font-semibold">{domainName}</span>{' '}
            をどのDNSに任せるかの指定を差し替えます（レジストリの domain:update）。
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>変更前にご確認ください</AlertTitle>
          <AlertDescription>
            <p>{NS_CHANGE_WARNING}</p>
          </AlertDescription>
        </Alert>

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

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button disabled={busy} onClick={handleSubmit}>
            {busy ? '変更中…' : '変更を保存する'}
          </Button>
        </DialogFooter>
    </>
  )
}
