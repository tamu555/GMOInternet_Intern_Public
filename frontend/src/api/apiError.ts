/**
 * Normalized error type for every call to our own backend.
 *
 * Scope note: this maps *our* backend's HTTP status codes. The registry-side
 * two-stage judgement (HTTP status + result.code, spec §3.3) and the EPP code
 * table (§6.7: 2302 / 2303 / 2202 / 2306) live in the backend BRIDGE layer -
 * the browser never talks to a registry directly (§3.2.1).
 */
export type ApiErrorKind =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'server'
  | 'network'
  /**
   * The registry serving the requested TLD has been JUDGED unreachable —
   * 503s sustained for about a minute, not a single blip (backend
   * `details.reason === 'registry-unavailable'`, docs/仕様/
   * registry-unavailable.md). Unlike 'network', the command definitely did
   * not run.
   */
  | 'registryUnavailable'
  /**
   * The registry serving the requested TLD ANNOUNCED a maintenance window
   * over the poll queue and it is on right now (backend
   * `details.reason === 'registry-maintenance'`). Unlike
   * 'registryUnavailable' this is the registry's own word, not an inference
   * from 503s — the one case the UI may call メンテナンス.
   */
  | 'registryMaintenance'
  /**
   * The account-deletion Callables' domain-ownership guard refused the
   * request — backend `failed-precondition` with
   * `details.reason === 'domains_owned'` (functions/src/auth/
   * account-lifecycle.ts). Surfaces the race/stale-UI case where the
   * frontend's own pre-check (mypage's `DeleteAccountDialog`) missed a
   * domain the backend still counts.
   */
  | 'domainsOwned'
  | 'unknown'

export type FieldErrors = Readonly<Record<string, string>>

export type ApiErrorInit = {
  kind: ApiErrorKind
  status: number
  message?: string
  code?: string
  fieldErrors?: FieldErrors
  cause?: unknown
  /** kind 'registryMaintenance' only: announced end of the window (ISO 8601). */
  maintenanceUntil?: string | null
  /** kind 'domainsOwned' only: how many domains the caller still owns. */
  domainCount?: number | null
}

/** Generic fallbacks. Screens override these where the spec fixes the wording. */
const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  validation: '入力内容を確認してください。',
  unauthorized: 'ログインが必要です。',
  forbidden: 'この操作を行う権限がありません。',
  notFound: '対象が見つかりませんでした。',
  conflict: 'すでに登録されています。',
  server: '時間をおいて再度お試しください。',
  network: '通信に失敗しました。接続を確認して、時間をおいて再度お試しください。',
  registryUnavailable: 'レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。',
  registryMaintenance: 'レジストリがメンテナンス中のため、現在この操作を行えません。',
  domainsOwned: '保有中のドメインがあるため退会できません。',
  unknown: '予期しないエラーが発生しました。時間をおいて再度お試しください。',
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number
  readonly code: string | undefined
  readonly fieldErrors: FieldErrors | undefined
  readonly maintenanceUntil: string | null
  readonly domainCount: number | null

  constructor(init: ApiErrorInit) {
    super(init.message ?? DEFAULT_MESSAGES[init.kind], { cause: init.cause })
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status
    this.code = init.code
    this.fieldErrors = init.fieldErrors
    this.maintenanceUntil = init.maintenanceUntil ?? null
    this.domainCount = init.domainCount ?? null
  }
}

export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 400 || status === 422) return 'validation'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notFound'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'server'
  return 'unknown'
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** Generic user-facing text. Prefer the screen-specific maps where they exist. */
export function messageForError(error: unknown): string {
  if (isApiError(error)) return error.message || DEFAULT_MESSAGES[error.kind]
  return DEFAULT_MESSAGES.unknown
}
