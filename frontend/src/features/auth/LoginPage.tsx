/**
 * ログイン (docs/api-flow-diagrams.html FIG.6).
 *
 * この画面は「枠」だけを持つ: ブランドマーク、見出し、returnTo の案内、
 * 会員登録への導線。入力欄と Google ボタンは <LoginForm> にあり、かんたん
 * モードのステップ3にも同じものが埋め込まれている（同じ挙動を2箇所に
 * 書き写さないための分割）。
 *
 * The post-login redirect (returnTo, else the dashboard) is owned by
 * <RequireGuest>: once AuthContext turns "authenticated" this page is replaced.
 * Keeping the redirect in one place is what stops returnTo from being consumed
 * twice and landing the user on the wrong screen — so this page passes no
 * onSuccess to <LoginForm>.
 */
import { Link, useLocation } from 'react-router-dom'
import { StatusBanner } from '../../components/StatusBanner'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { isSafeReturnPath } from '../../auth/returnTo'
import { LoginForm } from './LoginForm'
import { BrandMark } from '../../components/BrandMark'

type LocationState = { returnTo?: string } | null

export function LoginPage() {
  const location = useLocation()

  const returnTo = (location.state as LocationState)?.returnTo
  const showReturnNotice = isSafeReturnPath(returnTo)

  return (
    <div className="mx-auto w-full max-w-md space-y-4 pt-6 sm:pt-12">
      <Card>
        <CardHeader className="gap-1.5 text-center">
          {/* The product mark, same one the header carries. */}
          <BrandMark className="mx-auto mb-2 size-11" />
          <h1 className="text-xl font-bold tracking-tight">ログイン</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            おかえりなさい。アカウントにログインして続けましょう。
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          {showReturnNotice ? (
            <StatusBanner tone="info">
              この先に進むにはログインが必要です。ログインすると{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{returnTo}</code>{' '}
              に戻ります。
            </StatusBanner>
          ) : null}

          <LoginForm />
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        はじめての方は{' '}
        <Link to="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
          会員登録
        </Link>
      </p>
    </div>
  )
}
