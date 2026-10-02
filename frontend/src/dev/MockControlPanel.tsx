/**
 * Dev-only control panel for the mock backend.
 *
 * Rendered only while MSW is enabled. It makes every branch of FIG.5-8 visually
 * verifiable without a backend: choose the response, then use the screen.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { FlaskConical, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  fetchForce503State,
  setForce503 as sendForce503,
  type DevForce503State,
  type Force503Registry,
} from '../api/devForce503Api'
import {
  clearMaintenanceWindow,
  fetchMaintenanceState,
  startMaintenanceWindow,
  type DevMaintenanceState,
} from '../api/devMaintenanceApi'
// Dev-only tooling kept inline rather than in a dedicated `api/` module: this
// button exists solely to exercise the auto-renew-OFF expiry sweep
// (functions/src/domain/expirySweep.ts) by hand, and keeping its two calls in
// this one file keeps the diff out of feature PRs.
import { invoke } from '../api/callable'
import { resetUsers } from '../mocks/db'
import {
  LATENCY_OPTIONS,
  getScenario,
  resetScenario,
  setScenario,
  subscribeScenario,
  type LoginScenario,
  type RegisterScenario,
  type SessionScenario,
} from '../mocks/scenario'

const REGISTER_OPTIONS: { value: RegisterScenario; label: string }[] = [
  { value: 'ok', label: '201 成功（両レジストリ contact 作成）' },
  { value: 'partial-contact', label: '201 成功（片方の contact 作成に失敗）' },
  { value: 'conflict', label: '409 メールアドレス重複' },
  { value: 'validation-error', label: '400 バリデーションエラー' },
  { value: 'server-error', label: '500 サーバエラー' },
]

const LOGIN_OPTIONS: { value: LoginScenario; label: string }[] = [
  { value: 'ok', label: '200 成功' },
  { value: 'unauthorized', label: '401 認証失敗' },
  { value: 'server-error', label: '500 サーバエラー' },
]

const SESSION_OPTIONS: { value: SessionScenario; label: string }[] = [
  { value: 'ok', label: '200 トークン有効' },
  { value: 'expired', label: '401 トークン失効' },
  { value: 'server-error', label: '500 サーバエラー' },
]

const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

const FIELD_CLASS = 'flex flex-col gap-1.5 text-sm'
const FIELD_LABEL_CLASS = 'text-sm font-medium'
const HINT_CLASS = 'text-xs text-muted-foreground leading-relaxed'

const FORCE_503_REGISTRIES: Force503Registry[] = ['kitaqsign', 'kitaqnic']

const MAINTENANCE_DURATION_OPTIONS = [5, 15, 30, 60]

/** "2026-08-27T05:30:00.000Z" -> "14:30" (local time). */
function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

export function MockControlPanel() {
  const scenario = useSyncExternalStore(subscribeScenario, getScenario)
  const [open, setOpen] = useState(false)

  // Registry 503 injection (docs/仕様/registry-unavailable.md §3): unlike
  // every other control on this panel it drives the REAL backend (emulator),
  // so the state lives server-side and is fetched when the panel opens.
  const [force503, setForce503View] = useState<DevForce503State | null>(null)
  const [force503Error, setForce503Error] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchForce503State()
      .then((state) => {
        if (cancelled) return
        setForce503View(state)
        setForce503Error(false)
      })
      .catch(() => {
        if (!cancelled) setForce503Error(true)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  async function toggleForce503(registry: Force503Registry, enabled: boolean) {
    try {
      setForce503View(await sendForce503(registry, enabled))
      setForce503Error(false)
    } catch {
      setForce503Error(true)
    }
  }

  // Announced-maintenance simulation (registry-unavailable.md §3.5): also a
  // real-backend injection, so the state lives server-side too.
  const [maintenance, setMaintenanceView] = useState<DevMaintenanceState | null>(null)
  const [maintenanceError, setMaintenanceError] = useState(false)
  const [maintenanceMinutes, setMaintenanceMinutes] = useState(15)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetchMaintenanceState()
      .then((state) => {
        if (cancelled) return
        setMaintenanceView(state)
        setMaintenanceError(false)
      })
      .catch(() => {
        if (!cancelled) setMaintenanceError(true)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  async function toggleMaintenance(registry: Force503Registry, active: boolean) {
    try {
      setMaintenanceView(
        active
          ? await clearMaintenanceWindow(registry)
          : await startMaintenanceWindow(registry, maintenanceMinutes),
      )
      setMaintenanceError(false)
    } catch {
      setMaintenanceError(true)
    }
  }

  // Auto-renew-OFF expiry sweep verification: creates a real domain via the
  // real createOrder callable, then rewrites its mirrored exDate to the near
  // past via devSetDomainExpiry, so a member only needs to flip autoRenew OFF
  // on MyPage and run the sweep to see it enter the cancellation flow.
  const [expiryTestStatus, setExpiryTestStatus] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; domainName: string } | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function createExpiryTestDomain() {
    setExpiryTestStatus({ kind: 'busy' })
    try {
      const domainName = `expiry-test-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}.com`
      const idempotencyKey = crypto.randomUUID()
      // Deliberately inline `invoke` calls (see module-level comment above):
      // this is dev-only tooling, not a feature the api/ modules need to know
      // about.
      await invoke<{ domainName: string; periodYears: number; idempotencyKey: string }, unknown>(
        'createOrder',
        { domainName, periodYears: 1, idempotencyKey },
      )
      await invoke<{ domainName: string }, { domainName: string; exDate: string }>(
        'devSetDomainExpiry',
        { domainName },
      )
      setExpiryTestStatus({ kind: 'done', domainName })
    } catch (error) {
      setExpiryTestStatus({ kind: 'error', message: String(error) })
    }
  }

  // The scheduled expiryWorker never fires in the emulator, so the same sweep
  // is reachable here by hand (mirrors the runExpirySweep callable's purpose).
  const [sweepStatus, setSweepStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'busy' }
    | { kind: 'done'; deleted: number; failures: number; scanned: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  async function runExpirySweepNow() {
    setSweepStatus({ kind: 'busy' })
    try {
      const result = await invoke<
        Record<string, never>,
        { scanned: number; deleted: number; skipped: number; failures: number }
      >('runExpirySweep', {})
      setSweepStatus({ kind: 'done', ...result })
    } catch (error) {
      setSweepStatus({ kind: 'error', message: String(error) })
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        className="fixed bottom-4 right-4 z-50 rounded-none shadow-lg"
        onClick={() => setOpen(true)}
      >
        <FlaskConical aria-hidden="true" />
        モックAPI設定
      </Button>
    )
  }

  return (
    <aside className="fixed bottom-4 right-4 z-50 w-80" aria-label="モックAPI設定">
      <Card className="max-h-[min(80vh,42rem)] overflow-y-auto shadow-lg">
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-primary" aria-hidden="true" />
            モックAPI（MSW）
          </CardTitle>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="閉じる"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            認証・新規登録のみ MSW のモックで動いています（他の画面は Firebase エミュレータの callable を呼びます）。
            デモ用アカウント:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">demo@example.com</code> /{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">password123</code>
            <br />
            新規登録ウィザード（/signup）のメール認証コードは Firestore の{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">verificationCodes</code>{' '}
            に毎回ランダム発行されます（固定値は廃止・画面には表示されません）。
          </p>

          <div className="space-y-1.5">
            <label className={FIELD_CLASS}>
              <span className={FIELD_LABEL_CLASS}>FIG.5 会員登録</span>
              <select
                className={SELECT_CLASS}
                value={scenario.register}
                onChange={(event) => setScenario({ register: event.target.value as RegisterScenario })}
              >
                {REGISTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className={HINT_CLASS}>
              「片方の contact 作成に失敗」は画面上は成功と同じ表示になるのが正しい挙動です（FIG.5）。
            </p>
          </div>

          <label className={FIELD_CLASS}>
            <span className={FIELD_LABEL_CLASS}>FIG.6 ログイン</span>
            <select
              className={SELECT_CLASS}
              value={scenario.login}
              onChange={(event) => setScenario({ login: event.target.value as LoginScenario })}
            >
              {LOGIN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-1.5">
            <label className={FIELD_CLASS}>
              <span className={FIELD_LABEL_CLASS}>FIG.7/8 セッション確認</span>
              <select
                className={SELECT_CLASS}
                value={scenario.session}
                onChange={(event) => setScenario({ session: event.target.value as SessionScenario })}
              >
                {SESSION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className={HINT_CLASS}>
              「401 トークン失効」にしてリロードすると FIG.7 の失効ブランチ、ログイン後に切り替えて
              保護APIを呼ぶと FIG.8 の一括検知が確認できます。
            </p>
          </div>

          <div className="space-y-1.5">
            <label className={FIELD_CLASS}>
              <span className={FIELD_LABEL_CLASS}>応答遅延</span>
              <select
                className={SELECT_CLASS}
                value={scenario.latencyMs}
                onChange={(event) => setScenario({ latencyMs: Number(event.target.value) })}
              >
                {LATENCY_OPTIONS.map((latency) => (
                  <option key={latency} value={latency}>
                    {latency} ms
                  </option>
                ))}
              </select>
            </label>
            <p className={HINT_CLASS}>2000ms にすると「確認中」のローディングをはっきり確認できます。</p>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <span className={FIELD_LABEL_CLASS}>レジストリ障害シミュレーション（503を強制返却）</span>
            {force503Error ? (
              <p className={HINT_CLASS}>
                状態を取得できませんでした。Firebase エミュレータが起動しているか確認してください。
              </p>
            ) : (
              FORCE_503_REGISTRIES.map((registry) => {
                const expiry = force503?.expiresAt[registry]
                return (
                  <label key={registry} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={force503?.flags[registry] ?? false}
                      disabled={force503 === null}
                      onCheckedChange={(checked) => void toggleForce503(registry, checked === true)}
                      aria-label={`${registry} への通信を503にする`}
                    />
                    <span className="font-mono text-[13px]">{registry}</span>
                    {force503?.health[registry] === 'unavailable' ? (
                      <span className="text-xs font-bold text-destructive">接続不能と判定済み</span>
                    ) : null}
                    {expiry ? (
                      <span className="text-xs text-muted-foreground">
                        〜{formatTimeOfDay(expiry)} 自動OFF
                      </span>
                    ) : null}
                  </label>
                )
              })
            )}
            <p className={HINT_CLASS}>
              ONにすると該当レジストリへの全リクエストが503になります。約60秒継続すると検索結果が「⏳
              一時購入不可」表示に切り替わります。消し忘れ対策としてスイッチは30分で自動OFFになります。
              ※この項目はMSWではなく実バックエンド（エミュレータ）への注入です。
            </p>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <span className={FIELD_LABEL_CLASS}>メンテナンス告知シミュレーション（🔧表示の検証）</span>
            {maintenanceError ? (
              <p className={HINT_CLASS}>
                状態を取得できませんでした。Firebase エミュレータが起動しているか確認してください。
              </p>
            ) : (
              <>
                <label className={FIELD_CLASS}>
                  <span className="text-xs text-muted-foreground">窓の長さ（開始時に適用）</span>
                  <select
                    className={SELECT_CLASS}
                    value={maintenanceMinutes}
                    onChange={(event) => setMaintenanceMinutes(Number(event.target.value))}
                  >
                    {MAINTENANCE_DURATION_OPTIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} 分
                      </option>
                    ))}
                  </select>
                </label>
                {FORCE_503_REGISTRIES.map((registry) => {
                  const summary = maintenance?.maintenance[registry]
                  return (
                    <div key={registry} className="flex items-center gap-2 text-sm">
                      <span className="font-mono text-[13px]">{registry}</span>
                      {summary?.active ? (
                        <span className="text-xs font-bold text-destructive">
                          メンテナンス中
                          {summary.windowEnd ? `（〜${formatTimeOfDay(summary.windowEnd)}）` : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">なし</span>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="ml-auto"
                        disabled={maintenance === null}
                        aria-label={`${registry} のメンテナンス窓を${summary?.active ? '解除' : '開始'}`}
                        onClick={() => void toggleMaintenance(registry, summary?.active === true)}
                      >
                        {summary?.active ? '解除' : '開始'}
                      </Button>
                    </div>
                  )
                })}
              </>
            )}
            <p className={HINT_CLASS}>
              poll告知メンテナンス（registry-unavailable.md §3.5）と同じ記録に検証用の窓を書き込みます。
              検索結果は即「🔧 メンテナンス中」になります。窓は終了時刻で自動解除されるため、消し忘れても残りません。
              ※実バックエンド（エミュレータ）への注入です。
            </p>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <span className={FIELD_LABEL_CLASS}>自動更新OFFの検証</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={expiryTestStatus.kind === 'busy'}
              onClick={() => void createExpiryTestDomain()}
            >
              期限ギリギリのドメインを作成
            </Button>
            {expiryTestStatus.kind === 'busy' ? (
              <p className={HINT_CLASS}>作成中…</p>
            ) : expiryTestStatus.kind === 'done' ? (
              <p className={HINT_CLASS}>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {expiryTestStatus.domainName}
                </code>{' '}
                を作成し、残り0日相当まで期限を進めました。マイページで自動更新をOFFにして
                runExpirySweep を実行すると解約手続きに入ります。
              </p>
            ) : expiryTestStatus.kind === 'error' ? (
              <p className="text-xs font-bold text-destructive">{expiryTestStatus.message}</p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sweepStatus.kind === 'busy'}
              onClick={() => void runExpirySweepNow()}
            >
              期限スイープを実行
            </Button>
            {sweepStatus.kind === 'busy' ? (
              <p className={HINT_CLASS}>実行中…</p>
            ) : sweepStatus.kind === 'done' ? (
              <p className={HINT_CLASS}>
                対象{sweepStatus.scanned}件 / 解約{sweepStatus.deleted}件 / 失敗{sweepStatus.failures}件。
                解約された分はマイページで「解約手続き中」になります。
              </p>
            ) : sweepStatus.kind === 'error' ? (
              <p className="text-xs font-bold text-destructive">{sweepStatus.message}</p>
            ) : null}
            <p className={HINT_CLASS}>
              実際に createOrder でドメインを購入し、devSetDomainExpiry で有効期限のみ書き換えます。
              「期限スイープを実行」は本番で毎日動く expiryWorker と同じ処理（runExpirySweep）を即時実行します。
              ログインが必要です。※実バックエンド（エミュレータ）への注入です。
            </p>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" size="sm" onClick={resetScenario}>
              設定を初期化
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                resetUsers()
                window.location.reload()
              }}
            >
              登録済みアカウントを初期化
            </Button>
          </div>
        </CardContent>
      </Card>
    </aside>
  )
}
