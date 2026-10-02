/**
 * 貼り付けパーサダイアログ (§6.3.3c): ホスティング会社の設定案内のコピペを
 * parseDnsPaste でレコード案に変換する。読み取れなかった行は隠さず
 * 「読み取れなかった行」としてそのまま見せる（黙って捨てない）。
 */
import { ScanText } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { parseDnsPaste, type ParseResult } from './pasteParser'
import type { DnsRecord } from './dnsRecordTypes'

type PasteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdopt: (records: DnsRecord[]) => void
}

export function PasteDialog({ open, onOpenChange, onAdopt }: PasteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* クローズでアンマウント → 開くたびに入力・結果は初期化される。 */}
      <DialogContent className="sm:max-w-lg">
        <PasteDialogBody onAdopt={onAdopt} />
      </DialogContent>
    </Dialog>
  )
}

function PasteDialogBody({ onAdopt }: { onAdopt: (records: DnsRecord[]) => void }) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ParseResult | null>(null)

  return (
    <>
      <DialogHeader>
        <DialogTitle>案内文を貼り付ける</DialogTitle>
        <DialogDescription>
          サービスから届いた設定案内（Type / Name / Value の表や文章）を、そのままコピーして貼り付けてください。読み取れた内容だけを入力欄に入れます。
        </DialogDescription>
      </DialogHeader>

      <label className="flex flex-col gap-1.5 text-sm font-semibold">
        設定案内のテキスト
        <textarea
          className="min-h-32 rounded-md border border-input bg-card px-3 py-2 font-mono text-[13px] font-normal placeholder:text-ink-hint"
          placeholder={'例:\nType: CNAME\nName: www\nValue: cname.example.com'}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      <div>
        <Button variant="outline" size="sm" disabled={text.trim() === ''} onClick={() => setResult(parseDnsPaste(text))}>
          <ScanText />
          読み取る
        </Button>
      </div>

      {result ? (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold">読み取れたレコード案</p>
            {result.records.length > 0 ? (
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {result.records.map((record, index) => (
                  <li key={index} className="rounded-md bg-muted px-3 py-2 font-mono text-[13px]">
                    {record.type} {record.name} → {record.value}
                    {record.priority !== undefined ? `（優先度 ${record.priority}）` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-muted-foreground">
                レコードを読み取れませんでした。Type / Name / Value が含まれる部分を貼り付けてください。
              </p>
            )}
          </div>
          {result.skippedLines.length > 0 ? (
            <div>
              <p className="text-sm font-semibold">読み取れなかった行</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {result.skippedLines.map((line, index) => (
                  <li key={index} className="truncate font-mono text-xs text-muted-foreground">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button
          disabled={!result || result.records.length === 0}
          onClick={() => result && onAdopt(result.records)}
        >
          レコード案に追加
        </Button>
      </DialogFooter>
    </>
  )
}
