/**
 * レコード設定モード (§6.3.3a「いいえ」側) の進行役。
 *
 * 1画面に全部を出す表形式をやめ、4ステップに分けている:
 *   1 作り方を選ぶ (DnsMethodStep)  — 入力の入口は3つ。①テンプレート
 *     (RecipeDialog §6.3.3b) ②貼り付けパーサ (PasteDialog §6.3.3c) ③手動。
 *   2 内容を入力 (RecordCard)      — 1件=1カード。エラーは触れた項目から出す。
 *   3 確認 (DnsConfirmStep)        — 全置換で何が消えるかを保存前に見せる。
 *   4 完了 (DnsDoneStep)           — 反映状況の確認と次にやること。
 * 進行表示 (DNS_EDITOR_STEPS) は、この4つの前にモード選択を1歩目として置く。
 *
 * 編集中の行（rows）とサーバ保存済み（saved）は分離し、保存は全置換の
 * saveDnsRecords に normalizeDnsRecord を通した全量を送る。
 */
import { ArrowLeft, ArrowRight, ClipboardPaste, Plus, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { messageForError } from '../../api/apiError'
import { saveDnsRecords } from '../../api/dnsApi'
import { StatusBanner } from '../../components/StatusBanner'
import type { DnsDelegation } from './dnsCheckStatus'
import { DnsConfirmStep } from './DnsConfirmStep'
import { DnsDoneStep } from './DnsDoneStep'
import { DnsMethodStep } from './DnsMethodStep'
import { DNS_EDITOR_STEPS, type DnsEditorStep } from './dnsEditorSteps'
import { DnsStepper } from './DnsStepper'
import {
  EDIT_HAS_ERRORS_NOTICE,
  EDIT_NO_RECORDS_NOTICE,
  EDIT_STEP_HINT,
  EDIT_STEP_TITLE,
  METHOD_TEMPLATE_LABEL,
} from './dnsMessages'
import type { DnsRecord } from './dnsRecordTypes'
import { normalizeDnsRecord, validateDnsRecords, type RecordFieldErrors } from './dnsValidation'
import { dedupeKey, emptyRow, recordFromRow, rowFromRecord, type DraftRow } from './draftRows'
import { PasteDialog } from './PasteDialog'
import { RecipeDialog } from './RecipeDialog'
import { RecordCard } from './RecordCard'

const ERROR_FIELDS: readonly (keyof RecordFieldErrors)[] = ['type', 'name', 'value', 'ttl', 'priority']

export function RecordEditorMode({
  domainName,
  saved,
  delegation,
  onSavedChange,
  onSwitchToNsMode,
}: {
  domainName: string
  saved: DnsRecord[]
  /** 完了ステップの確認パネルへ素通しする委任状態（§3.5 status 由来）。 */
  delegation: DnsDelegation
  onSavedChange: (records: DnsRecord[]) => void
  onSwitchToNsMode: () => void
}) {
  const [rows, setRows] = useState<DraftRow[]>(() => saved.map(rowFromRecord))
  // 保存済みのドメインを開いたときは「現在の設定」＝完了ステップから始める。
  const [step, setStep] = useState<DnsEditorStep>(saved.length > 0 ? 'done' : 'method')
  const [justSaved, setJustSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 触れていない項目のエラーは出さない（入力途中の赤字を避ける）。 */
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())
  const [showAllErrors, setShowAllErrors] = useState(false)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)

  const draftRecords = rows.map(recordFromRow)
  const { recordErrors, warnings } = validateDnsRecords(draftRecords)
  const hasErrors = recordErrors.size > 0
  const dirty = JSON.stringify(draftRecords) !== JSON.stringify(saved)

  function visibleErrorsFor(row: DraftRow, index: number): RecordFieldErrors {
    const errors = recordErrors.get(index)
    if (!errors) return {}
    if (showAllErrors) return errors
    const visible: RecordFieldErrors = {}
    for (const field of ERROR_FIELDS) {
      const message = errors[field]
      if (message !== undefined && touchedFields.has(`${row.id}:${field}`)) visible[field] = message
    }
    return visible
  }

  const visibleErrorCount = rows.filter(
    (row, index) => Object.keys(visibleErrorsFor(row, index)).length > 0,
  ).length

  function markTouched(rowId: number, field: keyof RecordFieldErrors) {
    setTouchedFields((current) => new Set(current).add(`${rowId}:${field}`))
  }

  function patchRow(id: number, patch: Partial<DraftRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  /** テンプレート・貼り付けからの取り込み: 既存と同一 type+name+value の行は足さない。 */
  function addRecords(records: DnsRecord[]) {
    setRows((current) => {
      const seen = new Set(current.map((row) => dedupeKey(recordFromRow(row))))
      const fresh = records.filter((record) => {
        const key = dedupeKey(record)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return [...current, ...fresh.map(rowFromRecord)]
    })
    setStep('edit')
  }

  function addEmptyRow() {
    setRows((current) => [...current, emptyRow()])
    setStep('edit')
  }

  function goToConfirm() {
    if (hasErrors) {
      // 触れていない項目に隠れたエラーがある — ここで全部見せて理由を示す。
      setShowAllErrors(true)
      return
    }
    setActionError(null)
    setStep('confirm')
  }

  async function handleSave() {
    setActionError(null)
    setBusy(true)
    try {
      const result = await saveDnsRecords(domainName, draftRecords.map(normalizeDnsRecord))
      onSavedChange(result.records)
      setRows(result.records.map(rowFromRecord))
      setTouchedFields(new Set())
      setShowAllErrors(false)
      setJustSaved(true)
      setStep('done')
    } catch (error) {
      setActionError(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <DnsStepper steps={DNS_EDITOR_STEPS} current={step} />

      {step === 'method' ? (
        <>
          <DnsMethodStep
            hasSavedRecords={saved.length > 0}
            onTemplate={() => setRecipeOpen(true)}
            onPaste={() => setPasteOpen(true)}
            onManual={addEmptyRow}
          />
          {rows.length > 0 ? (
            <div>
              <Button variant="outline" onClick={() => setStep('edit')}>
                <ArrowLeft />
                入力中の内容に戻る
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {step === 'edit' ? (
        <Card>
          <CardHeader>
            <CardTitle>{EDIT_STEP_TITLE}</CardTitle>
            <CardDescription>{EDIT_STEP_HINT}</CardDescription>
            <CardAction>{dirty ? <Badge variant="outline">未保存の変更があります</Badge> : null}</CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRecipeOpen(true)}>
                <WandSparkles />
                {METHOD_TEMPLATE_LABEL}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setPasteOpen(true)}>
                <ClipboardPaste />
                案内文を貼り付けて読み取る
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={addEmptyRow}>
                <Plus />
                行を追加
              </Button>
            </div>

            {actionError ? <StatusBanner tone="error">{actionError}</StatusBanner> : null}

            {warnings.length > 0 ? (
              <Alert variant="warning">
                <AlertTitle>ご確認ください</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {rows.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{EDIT_NO_RECORDS_NOTICE}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {rows.map((row, index) => (
                  <RecordCard
                    key={row.id}
                    index={index}
                    row={row}
                    domainName={domainName}
                    errors={visibleErrorsFor(row, index)}
                    disabled={busy}
                    onPatch={(patch) => patchRow(row.id, patch)}
                    onTouch={(field) => markTouched(row.id, field)}
                    onRemove={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
                  />
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" disabled={busy} onClick={() => setStep(saved.length > 0 ? 'done' : 'method')}>
                <ArrowLeft />
                戻る
              </Button>
              <Button disabled={busy || rows.length === 0 || visibleErrorCount > 0} onClick={goToConfirm}>
                確認へ進む
                <ArrowRight />
              </Button>
              {visibleErrorCount > 0 ? (
                <p className="text-[13px] font-semibold text-destructive">{EDIT_HAS_ERRORS_NOTICE}</p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'confirm' ? (
        <DnsConfirmStep
          domainName={domainName}
          records={draftRecords.map(normalizeDnsRecord)}
          saved={saved}
          busy={busy}
          actionError={actionError}
          onBack={() => setStep('edit')}
          onSave={() => void handleSave()}
        />
      ) : null}

      {step === 'done' ? (
        <DnsDoneStep
          domainName={domainName}
          records={saved}
          delegation={delegation}
          justSaved={justSaved}
          onEdit={() => {
            setJustSaved(false)
            setStep('edit')
          }}
        />
      ) : null}

      <RecipeDialog
        open={recipeOpen}
        onOpenChange={setRecipeOpen}
        onAdopt={(records) => {
          addRecords(records)
          setRecipeOpen(false)
        }}
        onSwitchToNsMode={() => {
          setRecipeOpen(false)
          onSwitchToNsMode()
        }}
      />
      <PasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onAdopt={(records) => {
          addRecords(records)
          setPasteOpen(false)
        }}
      />
    </div>
  )
}
