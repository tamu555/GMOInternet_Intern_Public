/**
 * Step 1 新規登録画面 (/signup).
 *
 * Collects the account basics, then calls startSignup (mock - the backend
 * "sends" the verification code) and moves to step 2. react-hook-form + zod
 * (accountSchema.ts) render errors next to each field via the shadcn Form
 * primitives.
 */
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { ApiError, isApiError } from '../../api/apiError'
import { startSignup } from '../../api/signupApi'
import { useAuth } from '../../auth/useAuth'
import { messageForLoginError } from '../auth/authMessages'
import { PasswordInput } from '../auth/PasswordField'
import { accountSchema, type AccountFormValues } from './accountSchema'
import {
  NAME_KANA_LABEL,
  NAME_KANA_PLACEHOLDER,
  NAME_LABEL,
  NAME_PLACEHOLDER,
} from './nameRules'
import { useSignup } from './useSignup'
import { useSignupGate } from './useSignupGate'

function messageForStartError(error: unknown): string {
  if (isApiError(error) && error.kind === 'conflict') {
    return 'このメールアドレスはすでに登録されています。ログイン画面からお進みください。'
  }
  if (isApiError(error) && error.kind === 'validation') return error.message
  return '時間をおいて再度お試しください。'
}

export function SignupAccountPage() {
  const gate = useSignupGate('account')
  const { state, saveAccount } = useSignup()
  const { loginWithGoogle } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [formError, setFormError] = useState<string | null>(null)
  const [googleSubmitting, setGoogleSubmitting] = useState(false)

  // Set by useSignupGate when a later step was left without the in-memory
  // password. Shown until this screen raises an error of its own.
  const notice = (location.state as { notice?: string } | null)?.notice ?? null

  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      name: state.data.name,
      nameKana: state.data.nameKana,
      email: state.data.email,
      password: state.data.password,
      passwordConfirm: state.data.password,
      agreeTerms: false,
    },
  })

  if (gate) return gate

  async function onSubmit(values: AccountFormValues) {
    setFormError(null)
    try {
      await startSignup({
        email: values.email,
        password: values.password,
        name: values.name,
        nameKana: values.nameKana,
      })
      saveAccount({
        name: values.name,
        nameKana: values.nameKana,
        email: values.email,
        password: values.password,
      })
      navigate('/signup/verify')
    } catch (error) {
      setFormError(messageForStartError(error))
    }
  }

  // Google auth has no separate sign-up/sign-in intent - resolveLoginState
  // decides "active" vs. "additional_info_required" server-side regardless
  // of which entry point (here or LoginPage.tsx) triggered it, so this
  // mirrors handleGoogleLogin there. On "active" (an existing account signed
  // in from the registration screen), useSignupGate('account')'s own guard
  // above redirects once AuthState flips to authenticated - no explicit
  // navigation needed here, same as <RequireGuest> does for LoginPage.tsx.
  async function handleGoogleSignup() {
    setFormError(null)
    setGoogleSubmitting(true)
    try {
      const outcome = await loginWithGoogle()
      if (outcome === 'needs_additional_info') {
        navigate('/signup/additional-info')
      }
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

  const submitting = form.formState.isSubmitting

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="gap-1.5">
        <CardTitle className="text-lg"><h1 className="text-lg font-semibold">新規登録</h1></CardTitle>
        <CardDescription>アカウント作成に必要な情報を入力してください。</CardDescription>
      </CardHeader>
      <CardContent>
        {(formError ?? notice) ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertDescription>{formError ?? notice}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} noValidate className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{NAME_LABEL}</FormLabel>
                    <FormControl>
                      <Input placeholder={NAME_PLACEHOLDER} autoComplete="name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nameKana"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{NAME_KANA_LABEL}</FormLabel>
                    <FormControl>
                      <Input placeholder={NAME_KANA_PLACEHOLDER} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>メールアドレス</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="you@example.com" autoComplete="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>パスワード</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="passwordConfirm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>パスワード確認</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="agreeTerms"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-2">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                    </FormControl>
                    <FormLabel className="font-normal">
                      <span>
                        <a href="#terms" className="font-medium text-primary underline-offset-4 hover:underline">
                          利用規約
                        </a>
                        に同意します
                      </span>
                    </FormLabel>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full" disabled={submitting || googleSubmitting}>
              {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? '送信しています…' : '新規登録'}
            </Button>
          </form>
        </Form>

        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          または
          <span className="h-px flex-1 bg-border" />
        </div>

        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full"
          disabled={submitting || googleSubmitting}
          onClick={() => void handleGoogleSignup()}
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

        <p className="mt-4 text-center text-sm text-muted-foreground">
          すでにアカウントをお持ちの方は{' '}
          <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            ログインはこちら
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
