/**
 * The single call path to our backend's Firebase callable functions.
 *
 * Same intent as httpClient.ts had for the provisional REST layer: keep the
 * shared responsibilities in one place instead of spreading them over call
 * sites.
 *   1. httpsCallable construction (memoized per function name)
 *   2. error normalization into ApiError (FunctionsError code -> kind/status)
 *   3. AbortSignal support (the SDK has none; we race the call)
 *
 * Auth note: the Firebase ID token is attached automatically by the SDK from
 * firebaseAuth's current user. Unlike httpClient.ts there is deliberately no
 * unauthorizedBus wiring here - the bus belongs to the provisional MSW token
 * session, which is independent of the Firebase auth state.
 */
import { FirebaseError } from 'firebase/app'
import { httpsCallable, type HttpsCallable } from 'firebase/functions'
import { functions as functionsClient } from '../firebase/client'
import { ApiError, type ApiErrorKind, type FieldErrors } from './apiError'

export type InvokeOptions = {
  signal?: AbortSignal
}

/**
 * FunctionsError code (without the "functions/" prefix) -> ApiError kind and
 * the synthetic HTTP status the rest of the app already understands. The
 * mapping mirrors functions/src/api/httpsErrors.ts on the backend side.
 */
const CODE_MAP: Record<string, { kind: ApiErrorKind; status: number }> = {
  unauthenticated: { kind: 'unauthorized', status: 401 },
  'invalid-argument': { kind: 'validation', status: 400 },
  'out-of-range': { kind: 'validation', status: 400 },
  'failed-precondition': { kind: 'validation', status: 400 },
  'permission-denied': { kind: 'forbidden', status: 403 },
  'not-found': { kind: 'notFound', status: 404 },
  'already-exists': { kind: 'conflict', status: 409 },
  // The backend's "another invocation is already doing this" answer
  // (MutationConflictError / TransferError 'busy' in httpsErrors.ts).
  aborted: { kind: 'conflict', status: 409 },
  unavailable: { kind: 'network', status: 0 },
  'deadline-exceeded': { kind: 'network', status: 0 },
  internal: { kind: 'server', status: 500 },
  'resource-exhausted': { kind: 'server', status: 500 },
  unknown: { kind: 'server', status: 500 },
}

/**
 * Reads the two shapes the backend uses to blame one input.
 *
 * `{fieldErrors: {name: message}}` is what the stub codebase sends; the real
 * codebase's `httpsErrors.ts` instead sends `{field: 'authInfo'}` and puts the
 * text in the error message (ValidationError and TransferError
 * 'authInfoMismatch' both do this). Both end up as `ApiError.fieldErrors` so a
 * form can highlight the offending input either way.
 */
function fieldErrorsFrom(details: unknown, message: string | undefined): FieldErrors | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined
  const record = (details as { fieldErrors?: unknown }).fieldErrors
  if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
    const entries = Object.entries(record as Record<string, unknown>)
    if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) return undefined
    return record as FieldErrors
  }
  const field = (details as { field?: unknown }).field
  if (typeof field !== 'string' || field === '' || !message) return undefined
  return { [field]: message }
}

/**
 * Backend marker for "the registry has been judged unreachable" — attached
 * only once the circuit breaker saw 503s sustained for ~1 minute
 * (httpsErrors.ts, docs/仕様/registry-unavailable.md).
 */
function isRegistryUnavailable(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'registry-unavailable'
  )
}

/**
 * Backend marker for "the registry announced a maintenance window and it is
 * on" — the registry's own word over the poll queue, the one signal allowed
 * to be worded as メンテナンス (httpsErrors.ts, registryMaintenance.ts).
 */
function isRegistryMaintenance(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'registry-maintenance'
  )
}

/** Announced end of the maintenance window, when the backend passed one. */
function maintenanceUntilFrom(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null
  const until = (details as { until?: unknown }).until
  return typeof until === 'string' && until.length > 0 ? until : null
}

/**
 * Backend marker for "the caller still owns at least one domain" — the
 * account-deletion Callables' domain-ownership guard
 * (functions/src/auth/account-lifecycle.ts `details.reason ===
 * 'domains_owned'`).
 */
function isDomainsOwned(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    (details as { reason?: unknown }).reason === 'domains_owned'
  )
}

/** How many domains the backend counted, when it sent one. */
function domainCountFrom(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null
  const count = (details as { count?: unknown }).count
  return typeof count === 'number' && Number.isFinite(count) ? count : null
}

function toApiError(error: unknown): ApiError {
  if (error instanceof FirebaseError && error.code.startsWith('functions/')) {
    const bareCode = error.code.slice('functions/'.length)
    const details = (error as { details?: unknown }).details
    // `unavailable` alone means "could not reach the backend/registry"; the
    // details markers upgrade it to the judged "registry unreachable" state,
    // or to the registry's own announced maintenance
    // (docs/仕様/registry-unavailable.md §4).
    const mapped =
      bareCode === 'unavailable' && isRegistryMaintenance(details)
        ? { kind: 'registryMaintenance' as ApiErrorKind, status: 503 }
        : bareCode === 'unavailable' && isRegistryUnavailable(details)
          ? { kind: 'registryUnavailable' as ApiErrorKind, status: 503 }
          : bareCode === 'failed-precondition' && isDomainsOwned(details)
            ? { kind: 'domainsOwned' as ApiErrorKind, status: 400 }
            : (CODE_MAP[bareCode] ?? { kind: 'unknown' as ApiErrorKind, status: 0 })
    // The SDK uses the bare code as the message when the server gave none;
    // drop it so ApiError falls back to the user-facing default wording.
    const message = error.message && error.message !== bareCode ? error.message : undefined
    return new ApiError({
      kind: mapped.kind,
      status: mapped.status,
      message,
      code: error.code,
      fieldErrors: fieldErrorsFrom((error as { details?: unknown }).details, message),
      cause: error,
      maintenanceUntil:
        mapped.kind === 'registryMaintenance' ? maintenanceUntilFrom(details) : null,
      domainCount: mapped.kind === 'domainsOwned' ? domainCountFrom(details) : null,
    })
  }
  return new ApiError({ kind: 'unknown', status: 0, cause: error })
}

const callables = new Map<string, HttpsCallable<unknown, unknown>>()

/**
 * The SDK's default client-side timeout is 70s, shorter than the backend's
 * user-facing callables (timeoutSeconds up to 120 in functions/src/api/*.ts —
 * getOrder/createOrder resume real registry work and legitimately run long).
 * Giving up before the server does surfaces a bogus failure while the call
 * still succeeds server-side, so wait out the server limit plus a margin.
 */
export const CALLABLE_TIMEOUT_MS = 125_000

function callableFor(name: string): HttpsCallable<unknown, unknown> {
  let fn = callables.get(name)
  if (!fn) {
    fn = httpsCallable(functionsClient, name, { timeout: CALLABLE_TIMEOUT_MS })
    callables.set(name, fn)
  }
  return fn
}

export async function invoke<TReq, TRes>(
  name: string,
  data: TReq,
  options: InvokeOptions = {},
): Promise<TRes> {
  const { signal } = options
  if (signal?.aborted) throw signal.reason

  const call = callableFor(name)(data).then((result) => result.data as TRes)
  const raced = signal ? raceWithAbort(call, signal) : call

  try {
    return await raced
  } catch (cause) {
    // A caller-driven abort is not an error condition; let it propagate as-is.
    if (signal?.aborted) throw cause
    throw toApiError(cause)
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}
