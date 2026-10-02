/**
 * Maps every non-2xx outcome this app's Firebase-backed auth surface can
 * produce onto the single closed `ApiErrorKind` union (api/apiError.ts), so
 * every existing `error.kind === '...'` check downstream keeps compiling and
 * behaving unmodified regardless of which of the three source vocabularies
 * below actually produced the error.
 */
import { FirebaseError } from 'firebase/app'
import { ApiError, type ApiErrorKind } from '../api/apiError'

function stripPrefix(code: string, prefix: string): string {
  return code.startsWith(prefix) ? code.slice(prefix.length) : code
}

/** `firebase/functions` `httpsCallable` rejections (`HttpsError` codes thrown server-side). */
const CALLABLE_ERROR_KIND: Readonly<Record<string, ApiErrorKind>> = {
  'invalid-argument': 'validation',
  'already-exists': 'conflict',
  unauthenticated: 'unauthorized',
  'permission-denied': 'forbidden',
  'failed-precondition': 'conflict',
  'not-found': 'notFound',
  'deadline-exceeded': 'network',
  unavailable: 'network',
}

export function mapCallableError(error: unknown): ApiError {
  if (error instanceof FirebaseError) {
    const code = stripPrefix(error.code, 'functions/')
    return new ApiError({ kind: CALLABLE_ERROR_KIND[code] ?? 'server', status: 0, message: error.message, code, cause: error })
  }
  return new ApiError({ kind: 'unknown', status: 0, cause: error })
}

/** `firebase/auth` client SDK errors (`signInWithEmailAndPassword`, `signInWithPopup`). */
const AUTH_ERROR_KIND: Readonly<Record<string, ApiErrorKind>> = {
  'auth/wrong-password': 'unauthorized',
  'auth/user-not-found': 'unauthorized',
  'auth/invalid-credential': 'unauthorized',
  'auth/invalid-email': 'validation',
  'auth/too-many-requests': 'server',
}

/**
 * A user closing the Google popup (or a second popup request racing the
 * first) is not an error - the UI must stay silent and let them retry, not
 * show an error banner. Modeled as `kind: 'unknown'`, which
 * `mapCallableError`/`mapSessionFetchError` never produce for a real failure,
 * so callers can distinguish "silently retry-able" from every other case by
 * checking `kind === 'unknown'`.
 */
const AUTH_SILENT_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request'])

export function mapAuthError(error: unknown): ApiError {
  if (error instanceof FirebaseError) {
    if (AUTH_SILENT_CODES.has(error.code)) {
      return new ApiError({ kind: 'unknown', status: 0, message: error.message, code: error.code, cause: error })
    }
    return new ApiError({
      kind: AUTH_ERROR_KIND[error.code] ?? 'server',
      status: 0,
      message: error.message,
      code: error.code,
      cause: error,
    })
  }
  return new ApiError({ kind: 'unknown', status: 0, cause: error })
}

/** Raw `onRequest` JSON error envelope: `{error:{code,message}}` (functions/src/auth/session.ts). */
const ONREQUEST_ERROR_KIND: Readonly<Record<string, ApiErrorKind>> = {
  'invalid-argument': 'validation',
  unauthenticated: 'unauthorized',
  'permission-denied': 'forbidden',
  // A client-construction bug (wrong HTTP method), not a user-fixable input.
  'method-not-allowed': 'server',
  internal: 'server',
}

type SessionErrorEnvelope = { error?: { code?: string; message?: string } }

export function mapSessionFetchError(status: number, body: unknown): ApiError {
  const envelope = (body ?? {}) as SessionErrorEnvelope
  const code = envelope.error?.code
  const kind = (code ? ONREQUEST_ERROR_KIND[code] : undefined) ?? 'server'
  return new ApiError({ kind, status, message: envelope.error?.message, code })
}
