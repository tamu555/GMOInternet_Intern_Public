/**
 * Step 5 登録完了 (/signup/complete).
 *
 * Reached already signed in (SignupConfirmPage logs the new account in), so
 * マイページへ goes straight through the route guard.
 *
 * かんたんモードの途中から会員登録に来た人には、元のウィザードへ戻る導線を
 * 追加で出す（下書きは localStorage に残っているので同じステップに復帰する）。
 */
import { Link } from 'react-router-dom'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { hasPendingEasySession } from '../easy/easyStorage'
import { useSignupGate } from './useSignupGate'

export function SignupCompletePage() {
  const gate = useSignupGate('complete')

  if (gate) return gate

  const resumeEasyMode = hasPendingEasySession()

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <CircleCheck className="size-12 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">登録が完了しました</h1>
          <p className="text-sm text-muted-foreground">アカウントの登録が正常に完了しました。</p>
        </div>
        <div className="mt-2 flex flex-col items-stretch gap-2">
          {resumeEasyMode ? (
            <Button asChild size="lg">
              <Link to="/easy">かんたんモードの続きに戻る</Link>
            </Button>
          ) : null}
          <Button asChild size="lg" variant={resumeEasyMode ? 'outline' : 'default'}>
            <Link to="/mypage">マイページへ</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
