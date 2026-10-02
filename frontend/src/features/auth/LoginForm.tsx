/**
 * The login form itself: e-mail + password, the Google button, and the two
 * error banners that belong to signing in (session-restore failure and the
 * submit error).
 *
 *   200 -> { accessToken, user } -> AuthContext = "認証済み"
 *   401 -> "メールアドレスまたはパスワードが違います" (never says which one)
 *   5xx -> "時間をおいて再度お試しください"
 *
 * Extracted from LoginPage so the かんたんモード wizard can show a real,
 * working login at step 3/6 instead of a "ログインが必要です" sentence. The
 * page chrome (Card, BrandMark, the h1, the returnTo notice, the 会員登録
 * footer) stays in LoginPage — this component is only the form.
 *
 * Where the user goes after a successful sign-in is deliberately NOT decided
 * here. On /login it is owned by <RequireGuest> (one place resolves returnTo,
 * so it can never be consumed twice). Embedded in a flow that has no
 * RequireGuest above it, the host passes `onSuccess` and moves itself on.
 */
import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ApiError } from '../../api/apiError'
import { StatusBanner } from '../../components/StatusBanner'
import { Button } from '@/components/ui/button'
import { useAuth } from '../../auth/useAuth'
import {
  SESSION_CHECK_FAILED_MESSAGE,
  fieldErrorsFromApiError,
  messageForLoginError,
} from './authMessages'
import { EmailField } from './EmailField'
import { PasswordField } from './PasswordField'
import { validateEmail, validateLoginForm, type FormErrors, type LoginFormValues } from './validation'

const INITIAL_VALUES: LoginFormValues = {
  email: '',
  password: '',
}

function toFormErrors(error: unknown): FormErrors<LoginFormValues> {
  const backendErrors = fieldErrorsFromApiError(error)
  const mapped: FormErrors<LoginFormValues> = {}
  if (backendErrors.email) mapped.email = backendErrors.email
  if (backendErrors.password) mapped.password = backendErrors.password
  return mapped
}

export function LoginForm({ onSuccess }: { onSuccess?: () => void }) {
  const { login, loginWithGoogle, restoreError, recheckSession } = useAuth()
  const navigate = useNavigate()
  const idPrefix = useId()

  const [values, setValues] = useState<LoginFormValues>(INITIAL_VALUES)
  const [fieldErrors, setFieldErrors] = useState<FormErrors<LoginFormValues>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [googleSubmitting, setGoogleSubmitting] = useState(false)

  function updateValue<K extends keyof LoginFormValues>(key: K, value: LoginFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }))
  }

  /* 形式の警告はフォーカスを外した時に出し、直しはじめたその場で消す。
     打っている最中に赤くしないのは、まだ打ち終わっていない住所を
     「間違い」と言わないため。 */
  function handleEmailBlur() {
    if (!values.email.trim()) return
    setFieldErrors((current) => ({ ...current, email: validateEmail(values.email) }))
  }

  function handleEmailChange(value: string) {
    updateValue('email', value)
    if (fieldErrors.email) {
      setFieldErrors((current) => ({ ...current, email: validateEmail(value) }))
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    const errors = validateLoginForm(values)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)
    try {
      await login({
        email: values.email.trim(),
        password: values.password,
      })
      // Success: on /login <RequireGuest> sends the user to returnTo or the
      // dashboard, so there is nothing to do. Embedded hosts pass onSuccess.
      onSuccess?.()
    } catch (error) {
      setFieldErrors(toFormErrors(error))
      setFormError(messageForLoginError(error))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleGoogleLogin() {
    setFormError(null)
    setGoogleSubmitting(true)
    try {
      const outcome = await loginWithGoogle()
      if (outcome === 'needs_additional_info') {
        // No session exists yet; the profile has to be completed first. Same
        // destination wherever this form is embedded.
        navigate('/signup/additional-info')
        return
      }
      // 'active': same as the e-mail/password flow above.
      onSuccess?.()
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'unknown') {
        // The user closed the Google popup (or triggered a second one) -
        // not a real error, stay silent and let them retry.
        return
      }
      setFormError(messageForLoginError(error))
    } finally {
      setGoogleSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {restoreError ? (
        <StatusBanner
          tone="error"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void recheckSession()}>
              再確認する
            </Button>
          }
        >
          {SESSION_CHECK_FAILED_MESSAGE}
        </StatusBanner>
      ) : null}

      {formError ? <StatusBanner tone="error">{formError}</StatusBanner> : null}

      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        <EmailField
          idPrefix={idPrefix}
          value={values.email}
          onChange={handleEmailChange}
          onBlur={handleEmailBlur}
          error={fieldErrors.email}
          disabled={submitting}
        />

        <PasswordField
          idPrefix={idPrefix}
          value={values.password}
          onChange={(value) => updateValue('password', value)}
          error={fieldErrors.password}
          disabled={submitting}
          autoComplete="current-password"
        />

        <Button type="submit" className="w-full" disabled={submitting || googleSubmitting}>
          {submitting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              ログインしています…
            </>
          ) : (
            'ログイン'
          )}
        </Button>
      </form>

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        または
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={submitting || googleSubmitting}
        onClick={() => void handleGoogleLogin()}
      >
        {googleSubmitting ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            Googleでサインインしています…
          </>
        ) : (
          'Googleでサインイン'
        )}
      </Button>
    </div>
  )
}
