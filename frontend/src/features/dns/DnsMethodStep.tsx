/**
 * 入力の準備 (§6.3.3b/c): 3つの入口を同じ大きさのカードで並べ、
 * この画面では「どれで入力するか」以外を決めさせない。
 *
 * ⚠️ ここは「レコードを作る」画面だと説明しない。利用者にとっては、渡された
 * 案内をどう写すかを選んでいるだけ。用語は DnsModeBanner の開閉部にある。
 */
import { ClipboardPaste, PencilLine, WandSparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChoiceButton } from './ChoiceButton'
import { DNS_CHECK_LABELS } from './dnsCheckStatus'
import {
  METHOD_MANUAL_DESCRIPTION,
  METHOD_MANUAL_LABEL,
  METHOD_PASTE_DESCRIPTION,
  METHOD_PASTE_LABEL,
  METHOD_STEP_HINT,
  METHOD_STEP_QUESTION,
  METHOD_TEMPLATE_DESCRIPTION,
  METHOD_TEMPLATE_LABEL,
  RECORDS_NOT_SAVED_NOTICE,
} from './dnsMessages'

export function DnsMethodStep({
  hasSavedRecords,
  onTemplate,
  onPaste,
  onManual,
}: {
  hasSavedRecords: boolean
  onTemplate: () => void
  onPaste: () => void
  onManual: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{METHOD_STEP_QUESTION}</CardTitle>
        <CardDescription>{METHOD_STEP_HINT}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hasSavedRecords ? null : (
          // 現在の状態を先に1行で伝える（§6.3.3d の「未設定」と同じ文言）。
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <Badge variant="secondary" className="border-transparent text-muted-foreground">
              {DNS_CHECK_LABELS.unset.label}
            </Badge>
            {RECORDS_NOT_SAVED_NOTICE}
          </p>
        )}
        <ChoiceButton
          icon={WandSparkles}
          label={METHOD_TEMPLATE_LABEL}
          description={METHOD_TEMPLATE_DESCRIPTION}
          badge="かんたん"
          onClick={onTemplate}
        />
        <ChoiceButton
          icon={ClipboardPaste}
          label={METHOD_PASTE_LABEL}
          description={METHOD_PASTE_DESCRIPTION}
          onClick={onPaste}
        />
        <ChoiceButton
          icon={PencilLine}
          label={METHOD_MANUAL_LABEL}
          description={METHOD_MANUAL_DESCRIPTION}
          onClick={onManual}
        />
      </CardContent>
    </Card>
  )
}
