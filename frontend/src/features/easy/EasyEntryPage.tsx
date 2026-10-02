/**
 * `/easy` の入口。
 *
 * ⚠️ 以前はここで無言のまま「進める最も先のステップ」へ飛ばしていた。その結果、
 * `/easy` を開いた人はいきなり 2/6 の途中から、しかも前回入力した用途の文言が
 * 入った状態で始まり、初見の人には「なぜ途中から？」としか読めなかった
 * （issue #91）。続きから始めるかどうかは、本人に選ばせる。
 *
 * 選ばせないのは 2 つの場合だけ:
 *   - 下書きが空 … 選ばせるものが無い。そのままステップ1へ。
 *   - 注文発行済み … あれは「入力内容」ではなく購入済みドメインの設定途中で、
 *     「最初からやり直す」が意味を持たない（取得は取り消せない）。続きへ送る。
 *
 * 古すぎる下書きはそもそもここへ来ない — `easyStorage.ts` の
 * {@link EASY_DRAFT_TTL_MS} が読み出しの時点で捨てている。
 */
import { Navigate, useNavigate } from 'react-router-dom'
import { ArrowRight, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  ENTRY_HEADING,
  ENTRY_LEDE,
  ENTRY_RESTART_ACTION,
  ENTRY_RESUME_ACTION,
  ENTRY_SAVED_HEADING,
  ENTRY_SAVED_NAME_LABEL,
  ENTRY_SAVED_PURPOSE_LABEL,
} from './easyMessages'
import { purposeLabel } from './purposeOptions'
import { EASY_DONE_PATH, easyStepDef, furthestReachableStep } from './easyTypes'
import { useEasy } from './useEasy'

/** 保存されている内容の読み上げ。何を「続き」として引き継ぐのかを先に見せる。 */
function SavedSummary({ purpose, name }: { purpose: string; name: string }) {
  const rows = [
    purpose === '' ? null : { label: ENTRY_SAVED_PURPOSE_LABEL, value: purpose },
    name === '' ? null : { label: ENTRY_SAVED_NAME_LABEL, value: name },
  ].filter((row): row is { label: string; value: string } => row !== null)

  if (rows.length === 0) return null

  return (
    <div className="space-y-1.5 border-l-2 border-border pl-4">
      <p className="text-[13px] font-medium text-muted-foreground">{ENTRY_SAVED_HEADING}</p>
      <dl className="space-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function EasyEntryPage() {
  const { session, reset } = useEasy()
  const navigate = useNavigate()

  // 注文が出ている＝もう下書きではない。選ばせずに続き（つなぐ設定／完了）へ。
  if (session.orderId !== null) {
    const to = session.dnsPlan !== null ? EASY_DONE_PATH : easyStepDef('dns').path
    return <Navigate to={to} replace />
  }

  const resumeStep = furthestReachableStep(session)
  const firstStepPath = easyStepDef('goal').path
  // 「続き」と呼べるのは、ステップ1より先へ進んでいたときだけ。目的を選んだだけで
  // 引き返した人に選択肢を出しても、どちらを押しても同じ画面が出るだけになる。
  const hasResumableDraft = resumeStep !== 'goal' || session.purposeNote !== ''

  if (!hasResumableDraft) return <Navigate to={firstStepPath} replace />

  const startOver = () => {
    reset()
    navigate(firstStepPath, { replace: true })
  }

  const domainName = session.tld === '' ? session.label : `${session.label}${session.tld}`

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight">{ENTRY_HEADING}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{ENTRY_LEDE}</p>
      </CardHeader>

      <CardContent className="space-y-6">
        <SavedSummary purpose={purposeLabel(session.purpose)} name={domainName} />

        {/* 塗りのボタンは「続きから」1 つだけ。破棄は取り消せない操作なので、
            同じ重みで並べない（押し間違えた側だけが元に戻せない）。 */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            type="button"
            size="lg"
            className="w-full sm:w-auto sm:min-w-56"
            onClick={() => navigate(easyStepDef(resumeStep).path, { replace: true })}
          >
            {ENTRY_RESUME_ACTION}
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="lg" onClick={startOver}>
            <RotateCcw aria-hidden="true" />
            {ENTRY_RESTART_ACTION}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
