/**
 * Step 2 メール認証画面 (/signup/verify).
 *
 * The code is issued and checked server-side (api/signupApi.ts ->
 * `startEmailVerification` / `verifyEmailCode`). This screen deliberately
 * never renders the issued code: showing it here would hand it to anyone
 * looking at the screen, and the visitor obtains it through a separate
 * retrieval path instead.
 */
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { isApiError } from '../../api/apiError'
import { resendSignupCode, verifySignupCode } from '../../api/signupApi'
import { verifySchema, VERIFICATION_CODE_LENGTH, type VerifyFormValues } from './verifySchema'
import { useSignup } from './useSignup'
import { useSignupGate } from './useSignupGate'

export function SignupVerifyPage() {
  const gate = useSignupGate('verify')
  const { state, markEmailVerified } = useSignup()
  const navigate = useNavigate()
  const [resending, setResending] = useState(false)

  const form = useForm<VerifyFormValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { code: '' },
  })

  const email = state.data.email

  if (gate) return gate

  async function onSubmit(values: VerifyFormValues) {
    try {
      await verifySignupCode({ email, code: values.code })
      markEmailVerified()
      navigate('/signup/contract')
    } catch (error) {
      form.setError('code', {
        message:
          isApiError(error) && error.kind === 'validation'
            ? error.message
            : '認証できませんでした。時間をおいて再度お試しください。',
      })
    }
  }

  async function handleResend() {
    setResending(true)
    try {
      await resendSignupCode({ email })
      toast.success('認証コードを再送しました。')
    } catch (error) {
      toast.error(
        isApiError(error) && error.kind === 'validation'
          ? error.message
          : '再送できませんでした。時間をおいて再度お試しください。',
      )
    } finally {
      setResending(false)
    }
  }

  const submitting = form.formState.isSubmitting

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader className="gap-1.5 text-center">
        <CardTitle className="text-lg"><h1 className="text-lg font-semibold">メールアドレスを確認してください</h1></CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{email}</span> 宛の認証コードを発行しました。
          {VERIFICATION_CODE_LENGTH}桁のコードを入力してください。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} noValidate className="space-y-5">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                // FormItem is a grid, so `items-center` would only centre on
                // the block axis - the inline axis needs justify-items.
                <FormItem className="justify-items-center">
                  <FormLabel className="sr-only">認証コード</FormLabel>
                  <FormControl>
                    <InputOTP
                      maxLength={VERIFICATION_CODE_LENGTH}
                      value={field.value}
                      onChange={field.onChange}
                      autoFocus
                    >
                      <InputOTPGroup>
                        {Array.from({ length: VERIFICATION_CODE_LENGTH }, (_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </FormControl>
                  <FormMessage className="text-center" />
                </FormItem>
              )}
            />

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? '認証しています…' : '認証する'}
            </Button>
          </form>
        </Form>

        <div className="mt-4 flex flex-col items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => void handleResend()} disabled={resending}>
            認証コードを再送する
          </Button>
          <Button type="button" variant="link" size="sm" onClick={() => navigate('/signup')}>
            メールアドレスを変更する
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
