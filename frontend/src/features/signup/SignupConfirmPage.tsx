/**
 * Step 4 入力情報確認画面 (/signup/confirm).
 *
 * Read-only review of everything collected so far. 「この内容で登録する」
 * calls completeSignup (real Firebase registration + sign-in + sessionLogin,
 * see api/signupApi.ts), then re-checks the Cookie session so the app
 * observes the new member as authenticated before navigating to 完了.
 */
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { isApiError } from '../../api/apiError'
import { completeSignup } from '../../api/signupApi'
import { useAuth } from '../../auth/useAuth'
import { GENDERS } from './contractSchema'
import { SUPPORTED_COUNTRIES } from './countries'
import { NAME_KANA_LABEL, NAME_LABEL } from './nameRules'
import { clearSignupDraft } from './signupDraftStorage'
import { useSignup } from './useSignup'
import { useSignupGate } from './useSignupGate'

const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  individual: '個人',
  'sole-proprietor': '個人事業主',
  corporate: '法人',
}

function ConfirmRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  )
}

function SectionHeader({ title, onEdit }: { title: string; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold">{title}</h2>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
        編集する
      </Button>
    </div>
  )
}

export function SignupConfirmPage() {
  const gate = useSignupGate('confirm')
  const { state, markCompleted } = useSignup()
  const { recheckSession } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  if (gate) return gate

  const { data } = state
  const isBusiness = data.accountType !== 'individual'
  const companyNameLabel = data.accountType === 'sole-proprietor' ? '屋号' : '会社名'
  const genderLabel = GENDERS.find((option) => option.value === data.gender)?.label ?? data.gender
  const countryLabel = SUPPORTED_COUNTRIES.find((option) => option.code === data.address.country)?.label ?? data.address.country

  async function handleRegister() {
    if (submitting) return
    setSubmitting(true)
    setFormError(null)
    try {
      await completeSignup(data)
      // Order matters: mark completed BEFORE re-checking the session (the
      // gate exempts a completed flow from the authenticated-user eviction),
      // and navigate only AFTER the session check settled so no auth
      // re-render races the route change to /signup/complete.
      markCompleted()
      // Registration succeeded: drop the persisted PII mirror (issue #85).
      // Deliberately clearSignupDraft(), not reset() - reset() would also
      // set the in-memory state.completed back to false, which would fail
      // useSignupGate's `step === 'complete' && !state.completed` check and
      // bounce us straight back to /signup right after registering.
      clearSignupDraft()
      await recheckSession()
      navigate('/signup/complete', { replace: true })
    } catch (error) {
      setSubmitting(false)
      setFormError(
        isApiError(error) && error.kind === 'validation'
          ? error.message
          : '登録を完了できませんでした。時間をおいて再度お試しください。',
      )
    }
  }

  const editContract = () => navigate('/signup/contract')

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle className="text-lg"><h1 className="text-lg font-semibold">入力内容の確認</h1></CardTitle>
        <CardDescription>登録内容をご確認のうえ、「この内容で登録する」を押してください。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {formError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <section aria-label="基本情報" className="space-y-3">
          <SectionHeader title="基本情報" onEdit={editContract} />
          <dl className="space-y-2">
            <ConfirmRow label="契約者種別">{ACCOUNT_TYPE_LABEL[data.accountType] ?? data.accountType}</ConfirmRow>
            <ConfirmRow label={NAME_LABEL}>{data.name}</ConfirmRow>
            <ConfirmRow label={NAME_KANA_LABEL}>{data.nameKana}</ConfirmRow>
            <ConfirmRow label="メールアドレス">{data.email}</ConfirmRow>
            <ConfirmRow label="電話番号">{data.phoneNumber}</ConfirmRow>
            <ConfirmRow label="生年月日">{data.dateOfBirth}</ConfirmRow>
            <ConfirmRow label="性別">{genderLabel}</ConfirmRow>
            <ConfirmRow label="お知らせメール">{data.newsletterOptIn ? '受け取る' : '受け取らない'}</ConfirmRow>
          </dl>
        </section>

        {isBusiness && data.business ? (
          <>
            <Separator />
            <section aria-label="会社情報" className="space-y-3">
              <SectionHeader title="会社情報" onEdit={editContract} />
              <dl className="space-y-2">
                <ConfirmRow label={companyNameLabel}>{data.business.companyName}</ConfirmRow>
                <ConfirmRow label="部署名">{data.business.department || '—'}</ConfirmRow>
                <ConfirmRow label="担当者名">{data.business.contactPerson}</ConfirmRow>
              </dl>
            </section>
          </>
        ) : null}

        <Separator />

        <section aria-label="住所" className="space-y-3">
          <SectionHeader title="住所" onEdit={editContract} />
          <dl className="space-y-2">
            <ConfirmRow label="居住国">{countryLabel}</ConfirmRow>
            <ConfirmRow label="郵便番号">〒{data.address.postalCode}</ConfirmRow>
            {data.address.country === 'JP' ? (
              <ConfirmRow label="住所">
                {data.address.prefecture}
                {data.address.city}
                {data.address.addressLine}
                {data.address.building ? ` ${data.address.building}` : ''}
              </ConfirmRow>
            ) : (
              <ConfirmRow label="住所">
                {data.address.addressLine1}
                {data.address.addressLine2 ? `, ${data.address.addressLine2}` : ''}
                {data.address.city ? `, ${data.address.city}` : ''}
                {data.address.state ? `, ${data.address.state}` : ''}
              </ConfirmRow>
            )}
          </dl>
        </section>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
          <Button type="button" variant="outline" onClick={editContract} disabled={submitting}>
            戻って修正する
          </Button>
          <Button type="button" size="lg" onClick={() => void handleRegister()} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {submitting ? '登録しています…' : 'この内容で登録する'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
