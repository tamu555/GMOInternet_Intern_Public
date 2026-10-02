/**
 * §6.3.3(a) の分岐を、初心者が答えられる形にした画面。
 *
 * 使いみち（DnsGoalStep）を答えたあとに来る2画面目。仕様は「1問で分岐する」
 * ことを決めているが、その1問を画面の一番上に置くことまでは決めていない。
 * ここでは順番だけを入れ替えている:
 *   1. 先に動作を渡す（案内を開く）— 用語を知らなくても始められる
 *   2. 選択肢は「案内に何が書いてあるか」で名乗らせる
 *   3. 「分からない」を脚注ではなく3つ目の選択肢にする
 *   4. 仕様の問いそのもの（用語つき）は「くわしく知りたい方へ」の中に残す
 *
 * ⚠️ カードに仕様の答えラベル（「はい、渡された」/「いいえ／IPアドレスをもらった」）
 * をバッジで併記していたのはやめた（2026-08-28）。見出しが既に「案内に何が書いて
 * あるか」を言い切っているのに、その横に別の問い（＝渡されましたか？）への答えが
 * 並ぶので、何に答えているのか分からない一文になっていた。仕様のラベルは対になる
 * 問いと一緒に4の開閉パネルの中にだけ置く — そこでなら「はい、渡された」は問いへの
 * 答えとして読める。カード側に戻さないこと。
 */
import { ChevronDown, ChevronRight, CircleHelp, Clock, ListChecks, Server } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { GOAL_ECHO_MAIL, GOAL_ECHO_WEB, GOAL_RESELECT_LABEL, JARGON_DISCLOSURE_LABEL } from './connectMessages'
import { DisclosurePanel } from './DisclosurePanel'
import type { DnsGoal } from './dnsGoal'
import {
  DNS_INTRO_DURATION,
  DNS_INTRO_LEAD,
  DNS_INTRO_TITLE,
  DNS_MODE_EVIDENCE_QUESTION,
  DNS_MODE_HINT,
  DNS_MODE_NS_DESCRIPTION,
  DNS_MODE_NS_EVIDENCE,
  DNS_MODE_NS_EXAMPLE,
  DNS_MODE_NS_LABEL,
  DNS_MODE_NS_OUTCOME,
  DNS_MODE_QUESTION,
  DNS_MODE_QUESTION_NOTE,
  DNS_MODE_RECORDS_DESCRIPTION,
  DNS_MODE_RECORDS_EVIDENCE,
  DNS_MODE_RECORDS_EXAMPLE,
  DNS_MODE_RECORDS_LABEL,
  DNS_MODE_RECORDS_OUTCOME,
  DNS_MODE_UNSURE_FALLBACK_LABEL,
  DNS_MODE_UNSURE_FALLBACK_NOTE,
  DNS_MODE_UNSURE_HINT,
  DNS_MODE_UNSURE_LABEL,
  DNS_MODE_UNSURE_SUMMARY,
} from './dnsMessages'
import type { DnsMode } from './dnsMode'

type EvidenceOptionProps = {
  icon: LucideIcon
  /** 見出し = 案内に書かれている「見た目」。専門用語を使わない。 */
  evidence: string
  example: string
  /** 選ぶと何が起きるかの言い換え。 */
  outcome: string
  onClick: () => void
}

function EvidenceOption({ icon: Icon, evidence, example, outcome, onClick }: EvidenceOptionProps) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3.5 bg-muted p-4 text-left transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center bg-card text-primary">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{evidence}</span>
        <span className="mt-1 block font-mono text-xs break-all text-muted-foreground">例: {example}</span>
        <span className="mt-2 block text-[13px] leading-relaxed">{outcome}</span>
      </span>
    </button>
  )
}

export function DnsModeChoiceStep({
  goal,
  onSelect,
  onBackToGoal,
}: {
  /** 直前に選んだ使いみち。答え済みの内容は読み上げて、選び直せるようにする。 */
  goal: Exclude<DnsGoal, 'none'>
  onSelect: (mode: DnsMode) => void
  onBackToGoal: () => void
}) {
  const [unsureOpen, setUnsureOpen] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{DNS_INTRO_TITLE}</CardTitle>
        <CardDescription>
          {DNS_INTRO_LEAD}
          <span className="mt-2 flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <Clock aria-hidden="true" className="size-4 shrink-0 text-primary" />
            {DNS_INTRO_DURATION}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* 前の画面で答えた内容は読み上げ、間違えたときの戻り道を必ず添える。 */}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
          {goal === 'web' ? GOAL_ECHO_WEB : GOAL_ECHO_MAIL}
          <Button variant="link" size="sm" className="h-auto p-0 text-[13px]" onClick={onBackToGoal}>
            {GOAL_RESELECT_LABEL}
          </Button>
        </p>

        <p className="text-sm font-bold">{DNS_MODE_EVIDENCE_QUESTION}</p>

        <EvidenceOption
          icon={Server}
          evidence={DNS_MODE_NS_EVIDENCE}
          example={DNS_MODE_NS_EXAMPLE}
          outcome={DNS_MODE_NS_OUTCOME}
          onClick={() => onSelect('ns')}
        />
        <EvidenceOption
          icon={ListChecks}
          evidence={DNS_MODE_RECORDS_EVIDENCE}
          example={DNS_MODE_RECORDS_EXAMPLE}
          outcome={DNS_MODE_RECORDS_OUTCOME}
          onClick={() => onSelect('records')}
        />

        {/* 3つ目の選択肢: 迷った人の行き先を用意する（脚注にしない）。 */}
        <div className="bg-grass-1 p-4">
          <button
            type="button"
            aria-expanded={unsureOpen}
            className="flex w-full items-center gap-2 text-left text-sm font-bold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => setUnsureOpen((open) => !open)}
          >
            <CircleHelp aria-hidden="true" className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">{DNS_MODE_UNSURE_LABEL}</span>
            {unsureOpen ? (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
          {unsureOpen ? (
            <div className="mt-2 flex flex-col items-start gap-3">
              <p className="text-[13px] leading-relaxed">{DNS_MODE_UNSURE_HINT}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{DNS_MODE_UNSURE_FALLBACK_NOTE}</p>
              <Button onClick={() => onSelect('records')}>{DNS_MODE_UNSURE_FALLBACK_LABEL}</Button>
            </div>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{DNS_MODE_UNSURE_SUMMARY}</p>
          )}
        </div>

        {/* §6.3.3(a) の1問は消さず、用語を読みたい人にだけ届く位置へ下げる。 */}
        <DisclosurePanel label={JARGON_DISCLOSURE_LABEL}>
          <p className="text-muted-foreground">{DNS_MODE_QUESTION_NOTE}</p>
          <p>{DNS_MODE_QUESTION}</p>
          {/* 仕様が定める各モードの説明。用語（レコード・A/CNAME/MX）はここにだけ置く。 */}
          <p>
            <span className="block font-semibold">{DNS_MODE_NS_LABEL}</span>
            <span className="block">{DNS_MODE_NS_DESCRIPTION}</span>
          </p>
          <p>
            <span className="block font-semibold">{DNS_MODE_RECORDS_LABEL}</span>
            <span className="block">{DNS_MODE_RECORDS_DESCRIPTION}</span>
          </p>
          <p className="text-muted-foreground">{DNS_MODE_HINT}</p>
        </DisclosurePanel>
      </CardContent>
    </Card>
  )
}
