import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Globe, Rocket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBanner } from '../components/StatusBanner'
import { request } from '../api/httpClient'
import { messageForError } from '../api/apiError'
import { useAuth } from '../auth/useAuth'

/**
 * FIG.8（認証フロー）の動作確認画面。**製品の管理画面ではない**。
 *
 * 保有ドメインの管理はマイページ（/mypage）1つに集約しており、この画面は
 * 401 → returnTo → 復帰 の挙動を目で確かめるための検証用。名前を
 * 「ダッシュボード」から「認証の動作確認」に変えたのは、マイページと
 * 並び立つ管理画面だと誤解されないため。ヘッダーのナビには出さず、
 * フッターからのみ辿れる。
 *
 * Wire shape of the dev-only MSW endpoint GET /api/domains: it deliberately
 * stays on the provisional REST session (not callables) until the Firebase
 * Auth integration replaces it wholesale (auth workstream). The former
 * api/domainsApi.ts was deleted with the callable migration; the one
 * remaining call is inlined here.
 */
type DemoDomainSummary = { name: string; status: string }

export function DashboardPage() {
  const { state } = useAuth()
  const [domains, setDomains] = useState<DemoDomainSummary[] | null>(null)
  const [callError, setCallError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const user = state.status === 'authenticated' ? state.user : null

  async function handleFetchDomains() {
    setBusy(true)
    setCallError(null)
    setNotice(null)
    try {
      const result = await request<{ domains: DemoDomainSummary[] }>('/api/domains')
      setDomains(result.domains)
    } catch (error) {
      // A 401 here never reaches this catch as a user-visible error path: the
      // common HTTP client has already reset AuthContext, and RequireAuth is
      // redirecting to /login with returnTo=/dashboard (FIG.8).
      setDomains(null)
      setCallError(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevokeToken() {
    setBusy(true)
    setCallError(null)
    try {
      await request<void>('/api/dev/revoke-token', { method: 'POST' })
      setNotice(
        'トークンを失効させました。この状態で「保護APIを呼ぶ」を押すと 401 が返り、ログイン画面へ戻されます。',
      )
    } catch (error) {
      setCallError(messageForError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">認証の動作確認</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {user ? `${user.displayName} さん（${user.email}）としてログインしています。` : null}
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          この画面はログイン状態の挙動を確かめるための検証用です。取得したドメインの管理は
          マイページで行います。
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>認証フローの動作確認</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            このボタンは FIG.8 の下半分（API 呼び出し中に 401 が返るケース）を再現します。
            失効させたあとに保護APIを呼ぶと、共通HTTPクライアントが 401 を検知して
            AuthContext を「未認証」に戻し、
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">returnTo=/dashboard</code>{' '}
            を保存してログイン画面へ遷移します。
          </p>

          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => void handleFetchDomains()} disabled={busy}>
              保護APIを呼ぶ（GET /api/domains）
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleRevokeToken()} disabled={busy}>
              トークンを失効させる
            </Button>
          </div>

          {notice ? <StatusBanner tone="info">{notice}</StatusBanner> : null}
          {callError ? <StatusBanner tone="error">{callError}</StatusBanner> : null}

          {domains ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {domains.map((domain) => (
                <li key={domain.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="font-mono text-sm">{domain.name}</span>
                  <Badge variant="secondary">{domain.status}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>保護ルート</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            ログアウト状態で下のリンクを開くと、遷移先が{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">returnTo</code>{' '}
            に保存され、ログイン後にその画面へ戻ります（FIG.8）。
          </p>
          <ul className="space-y-1">
            {/* /domains is no longer protected (the search screen moved to the
                public top page), so the demo links point at routes that still are. */}
            <li>
              <Link
                to="/domains/new?domain=demo.com"
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
              >
                <Globe className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="flex-1 font-mono">/domains/new</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
            <li>
              {/* かんたんモードの最初の3ステップは公開ルートになったので、
                  保護されているのは契約内容の確認以降。 */}
              <Link
                to="/easy/confirm"
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
              >
                <Rocket className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="flex-1 font-mono">/easy/confirm</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
