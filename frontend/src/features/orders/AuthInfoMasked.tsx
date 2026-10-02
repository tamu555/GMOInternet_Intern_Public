/**
 * authInfo display: masked, copy-only (spec §7.3 "authInfoは画面には原則
 * マスク表示（コピーボタンのみ）"). There is deliberately NO reveal toggle,
 * and the mask is fixed-length so it leaks neither the value nor its length.
 */
import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AUTH_INFO_COPIED_MESSAGE, AUTH_INFO_COPY_FAILED_MESSAGE } from './orderMessages'

const MASK = '••••••••••••'

export function AuthInfoMasked({ authInfo }: { authInfo: string }) {
  const [copyResult, setCopyResult] = useState<'copied' | 'failed' | null>(null)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(authInfo)
      setCopyResult('copied')
    } catch {
      setCopyResult('failed')
    }
  }

  // The backend never hands a *stored* authInfo to the client (§7.3): the
  // value only exists here right after a rotation returned it. Before that,
  // rendering the mask over an empty string invites the exact failure it
  // caused — pressing コピー and pasting nothing. Say what to do instead,
  // and offer no copy button for a value that does not exist.
  if (authInfo.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground" role="status">
        認証コードは保存されていないため表示できません。ドメイン詳細の「再生成する」で新しいコードを発行すると、その場でコピーできます。
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-sm tracking-widest" aria-label="認証コード（マスク表示）">
        {MASK}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        <Copy aria-hidden="true" />
        コピー
      </Button>
      <span
        className={cn(
          'text-[13px] font-normal',
          copyResult === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
        role="status"
      >
        {copyResult === 'copied' ? AUTH_INFO_COPIED_MESSAGE : copyResult === 'failed' ? AUTH_INFO_COPY_FAILED_MESSAGE : null}
      </span>
    </div>
  )
}
