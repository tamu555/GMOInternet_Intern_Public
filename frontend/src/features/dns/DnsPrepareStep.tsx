/**
 * 「まだ何も用意していない」経路。
 *
 * ⚠️ この画面の目的は設定させることではない。ドメイン単体では何も表示されない
 * という前提を伝え、次に登録すべきサービスの実名を渡し、「いま何もしなくても
 * ドメインは無くならない」と言い切って、安心して離脱してもらう。
 * 出口を必ず2つ以上置くこと（詳細画面へ戻る／案内が手元にある人は設定へ）。
 */
import { ArrowLeft, ArrowRight, Globe, Mail, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  PREPARE_BACK_TO_DETAIL_LABEL,
  PREPARE_HAS_GUIDE_LABEL,
  PREPARE_LEAD,
  PREPARE_MAIL_BODY,
  PREPARE_MAIL_EXAMPLES,
  PREPARE_MAIL_TITLE,
  PREPARE_SAFE_BODY,
  PREPARE_SAFE_TITLE,
  PREPARE_SEQUENCE,
  PREPARE_SEQUENCE_TITLE,
  PREPARE_TITLE,
  PREPARE_WEB_BODY,
  PREPARE_WEB_EXAMPLES,
  PREPARE_WEB_TITLE,
  type PrepareExample,
} from './connectMessages'

function ExampleGroup({
  icon: Icon,
  title,
  body,
  examples,
}: {
  icon: typeof Globe
  title: string
  body: string
  examples: readonly PrepareExample[]
}) {
  return (
    <section className="bg-muted p-4">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
        {title}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
      <ul className="mt-2.5 flex flex-col gap-2">
        {examples.map((example) => (
          <li key={example.name} className="bg-card p-3">
            <p className="text-[13px] font-bold">{example.name}</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{example.note}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DnsPrepareStep({
  domainName,
  onBackToGoal,
}: {
  domainName: string
  /** 出口その2: 案内が手元にある人は、使いみちを選ぶところへ戻して設定へ送る。 */
  onBackToGoal: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{PREPARE_TITLE}</CardTitle>
        <CardDescription>{PREPARE_LEAD}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ExampleGroup
          icon={Globe}
          title={PREPARE_WEB_TITLE}
          body={PREPARE_WEB_BODY}
          examples={PREPARE_WEB_EXAMPLES}
        />
        <ExampleGroup
          icon={Mail}
          title={PREPARE_MAIL_TITLE}
          body={PREPARE_MAIL_BODY}
          examples={PREPARE_MAIL_EXAMPLES}
        />

        <section className="bg-grass-1 p-4">
          <h3 className="text-sm font-bold">{PREPARE_SEQUENCE_TITLE}</h3>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed">
            {PREPARE_SEQUENCE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </section>

        {/* 離脱を「失敗」にしない。ここを読まないと、迷った人は無理に設定して壊す。 */}
        <section className="bg-muted p-4">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-primary" />
            {PREPARE_SAFE_TITLE}
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed">{PREPARE_SAFE_BODY}</p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Button asChild>
            <Link to={`/mypage/domains/${encodeURIComponent(domainName)}`}>
              <ArrowLeft />
              {PREPARE_BACK_TO_DETAIL_LABEL}
            </Link>
          </Button>
          <Button variant="outline" onClick={onBackToGoal}>
            {PREPARE_HAS_GUIDE_LABEL}
            <ArrowRight />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
