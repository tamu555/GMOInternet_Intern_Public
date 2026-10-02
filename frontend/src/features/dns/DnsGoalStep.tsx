/**
 * 入口の1画面目。聞くのは「何を渡されたか」ではなく「何がしたいか」。
 *
 * 前の版は最初から「契約したサービスから届いた案内を開いてください」で始まって
 * いたため、ドメインを買っただけの人には進む先が1つも無かった。ここで
 * 「まだ何も用意していない」を3つ目の選択肢として正面に置く。
 *
 * 仕組みの説明（住所と置き場所がまだ結ばれていない）は、この画面で1度だけ
 * 図つきで渡す。以降の画面では繰り返さない。
 */
import { Globe, HelpCircle, Mail } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChoiceButton } from './ChoiceButton'
import { ConnectDiagram } from './ConnectDiagram'
import {
  CONNECT_MODEL_DIAGRAM_CAPTION,
  CONNECT_MODEL_TITLE,
  connectModelBody,
  GOAL_MAIL_DESCRIPTION,
  GOAL_MAIL_LABEL,
  GOAL_NONE_DESCRIPTION,
  GOAL_NONE_LABEL,
  GOAL_STEP_LEAD,
  GOAL_STEP_TITLE,
  GOAL_WEB_DESCRIPTION,
  GOAL_WEB_LABEL,
} from './connectMessages'
import type { DnsGoal } from './dnsGoal'

export function DnsGoalStep({
  domainName,
  onSelect,
}: {
  domainName: string
  onSelect: (goal: DnsGoal) => void
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* 仕組みの説明は選択肢より先。ここを読まずに選んでも困らない長さに保つ。 */}
      <section className="bg-grass-1 p-4" aria-labelledby="dns-connect-model-title">
        <h2 id="dns-connect-model-title" className="text-sm font-bold">
          {CONNECT_MODEL_TITLE}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed">{connectModelBody(domainName)}</p>
        <div className="mt-3 flex flex-col items-center gap-1.5">
          <ConnectDiagram />
          <p className="text-xs text-muted-foreground">{CONNECT_MODEL_DIAGRAM_CAPTION}</p>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{GOAL_STEP_TITLE}</CardTitle>
          <CardDescription>{GOAL_STEP_LEAD}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ChoiceButton
            icon={Globe}
            label={GOAL_WEB_LABEL}
            description={GOAL_WEB_DESCRIPTION}
            onClick={() => onSelect('web')}
          />
          <ChoiceButton
            icon={Mail}
            label={GOAL_MAIL_LABEL}
            description={GOAL_MAIL_DESCRIPTION}
            onClick={() => onSelect('mail')}
          />
          <ChoiceButton
            icon={HelpCircle}
            label={GOAL_NONE_LABEL}
            description={GOAL_NONE_DESCRIPTION}
            onClick={() => onSelect('none')}
          />
        </CardContent>
      </Card>
    </div>
  )
}
