/**
 * 移管INの申請画面 (spec §6.6.2, 通常モード版).
 *
 * The wizard's step order is kept on one page: ①ドメイン名 ②AuthCodeの発行案内
 * ③AuthCode貼り付け ④申請 → 承認待ち表示. 初心者最大の難所は「AuthCodeとは？
 * どこで発行？」なので、発行手順の案内をフォームと同格で置く。
 *
 * 申請後の進捗はマイページの TransferInSection が引き受ける（§6.6.2 step 4:
 * pendingTransfer の進捗表示）。この画面は申請直後の完了状態だけを持つ。
 *
 * Backend: 実装済みの `requestTransfer` callable（api/transferApi.ts）。
 */
import { ArrowLeftRight, CircleCheck, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Field } from '../../components/Field'
import { StatusBanner } from '../../components/StatusBanner'
import { isApiError, messageForError } from '../../api/apiError'
import { requestTransferIn, type Transfer } from '../../api/transferApi'
import { formatDateTimeJa } from '../mypage/domainDisplay'
import {
  AUTH_CODE_GUIDE_NOTE,
  AUTH_CODE_GUIDE_STEPS,
  AUTH_CODE_GUIDE_TITLE,
  TRANSFER_IN_PENDING_NOTE,
  transferInAutoApproveNote,
} from './transferMessages'
import {
  normalizeAuthInfo,
  normalizeTransferDomainName,
  validateTransferInForm,
  type TransferInFormErrors,
} from './transferValidation'
import { watchTransferIn } from './transferWatchlist'

/** 申請完了 (§6.6.2 step 4): the pendingTransfer hand-off to my-page. */
function RequestedView({ request }: { request: Transfer }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <CircleCheck className="size-8 text-primary" />
        <p className="text-lg font-semibold">移管を申請しました</p>
        <p className="font-mono text-sm font-semibold">{request.domainName}</p>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          {TRANSFER_IN_PENDING_NOTE}
        </p>
        {/* §6.6.1: 20分の自動承認期限。バックエンドが計算した値だけを表示する. */}
        {request.autoApproveAt ? (
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            {transferInAutoApproveNote(formatDateTimeJa(request.autoApproveAt))}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link to="/mypage">マイページで進捗を見る</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function TransferInPage() {
  const [domainName, setDomainName] = useState('')
  const [authInfo, setAuthInfo] = useState('')
  const [fieldErrors, setFieldErrors] = useState<TransferInFormErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [requested, setRequested] = useState<Transfer | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const values = {
      domainName: normalizeTransferDomainName(domainName),
      authInfo: normalizeAuthInfo(authInfo),
    }
    setDomainName(values.domainName)
    setAuthInfo(values.authInfo)

    const errors = validateTransferInForm(values)
    setFieldErrors(errors)
    setSubmitError(null)
    if (errors.domainName || errors.authInfo) return

    setBusy(true)
    try {
      const transfer = await requestTransferIn(values.domainName, values.authInfo)
      // FIG.9 の結果行のため: 承認/拒否されて一覧から消えたあとも結果を出せる.
      watchTransferIn(transfer.domainName)
      setRequested(transfer)
    } catch (error) {
      // authInfo不一致 (EPP 2202 / HTTP 401 相当) と TLD 非対応は、バックエンドが
      // details.field で入力欄を名指しする (callable.ts が fieldErrors に畳む).
      if (isApiError(error) && error.fieldErrors) {
        setFieldErrors({
          domainName: error.fieldErrors.domainName,
          authInfo: error.fieldErrors.authInfo,
        })
      } else {
        setSubmitError(messageForError(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ArrowLeftRight className="size-6 text-primary" />
          他社からドメインを移管する
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          別の会社で管理しているドメインを、このサービスに引っ越し（移管）します。ドメインが使えなくなる時間はありません。
        </p>
      </header>

      {requested ? (
        <RequestedView request={requested} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4 text-primary" />
                {AUTH_CODE_GUIDE_TITLE}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed">
                {AUTH_CODE_GUIDE_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{AUTH_CODE_GUIDE_NOTE}</p>
            </CardContent>
          </Card>

          {submitError ? <StatusBanner tone="error">{submitError}</StatusBanner> : null}

          <Card>
            <CardContent>
              <form className="flex flex-col gap-5" onSubmit={(event) => void handleSubmit(event)} noValidate>
                <Field
                  label="移管したいドメイン名"
                  controlId="transfer-domain"
                  hint="TLD（.com など）まで含めて入力してください。"
                  error={fieldErrors.domainName}
                >
                  {({ controlId, describedBy }) => (
                    <Input
                      id={controlId}
                      type="text"
                      placeholder="example.com"
                      className="font-mono"
                      value={domainName}
                      onChange={(event) => setDomainName(event.target.value)}
                      onBlur={() => setDomainName((value) => normalizeTransferDomainName(value))}
                      aria-describedby={describedBy}
                      aria-invalid={fieldErrors.domainName ? true : undefined}
                      autoComplete="off"
                      disabled={busy}
                    />
                  )}
                </Field>

                <Field
                  label="AuthCode（認証コード）"
                  controlId="transfer-authinfo"
                  hint="移管元で発行したコードをそのまま貼り付けてください。"
                  error={fieldErrors.authInfo}
                >
                  {({ controlId, describedBy }) => (
                    <Input
                      id={controlId}
                      type="text"
                      className="font-mono"
                      value={authInfo}
                      onChange={(event) => setAuthInfo(event.target.value)}
                      aria-describedby={describedBy}
                      aria-invalid={fieldErrors.authInfo ? true : undefined}
                      autoComplete="off"
                      disabled={busy}
                    />
                  )}
                </Field>

                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" type="button" asChild disabled={busy}>
                    <Link to="/mypage">キャンセル</Link>
                  </Button>
                  <Button type="submit" disabled={busy}>
                    <ArrowLeftRight />
                    移管を申請する
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
