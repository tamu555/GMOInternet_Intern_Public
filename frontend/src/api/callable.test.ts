import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { CALLABLE_TIMEOUT_MS, invoke } from './callable'
import { isApiError } from './apiError'

const callableMock = vi.fn<(data: unknown) => Promise<{ data: unknown }>>()

vi.mock('firebase/functions', () => ({
  httpsCallable: vi.fn(() => callableMock),
}))

vi.mock('../firebase/client', () => ({ functions: {} }))

function functionsError(code: string, message: string, details?: unknown): FirebaseError {
  const error = new FirebaseError(`functions/${code}`, message)
  if (details !== undefined) {
    ;(error as FirebaseError & { details?: unknown }).details = details
  }
  return error
}

async function invokeError(error: unknown): Promise<unknown> {
  callableMock.mockRejectedValueOnce(error)
  try {
    await invoke('anyFn', {})
    throw new Error('expected invoke to reject')
  } catch (thrown) {
    return thrown
  }
}

beforeEach(() => {
  callableMock.mockReset()
})

describe('invoke', () => {
  it('returns result.data on success', async () => {
    callableMock.mockResolvedValueOnce({ data: { ok: true } })
    await expect(invoke('anyFn', { q: 1 })).resolves.toEqual({ ok: true })
    expect(callableMock).toHaveBeenCalledWith({ q: 1 })
  })

  it('constructs the callable with a client timeout covering the server deadline', async () => {
    callableMock.mockResolvedValueOnce({ data: null })
    await invoke('timeoutFn', {})
    const call = vi.mocked(httpsCallable).mock.calls.find(([, name]) => name === 'timeoutFn')
    expect(call?.[2]).toEqual({ timeout: CALLABLE_TIMEOUT_MS })
  })

  it('memoizes the callable per function name', async () => {
    callableMock.mockResolvedValue({ data: null })
    await invoke('memoFn', {})
    await invoke('memoFn', {})
    const names = vi
      .mocked(httpsCallable)
      .mock.calls.map(([, name]) => name)
      .filter((name) => name === 'memoFn')
    expect(names).toHaveLength(1)
  })

  it.each([
    ['unauthenticated', 'unauthorized', 401],
    ['invalid-argument', 'validation', 400],
    ['out-of-range', 'validation', 400],
    ['failed-precondition', 'validation', 400],
    ['permission-denied', 'forbidden', 403],
    ['not-found', 'notFound', 404],
    ['already-exists', 'conflict', 409],
    ['aborted', 'conflict', 409],
    ['unavailable', 'network', 0],
    ['deadline-exceeded', 'network', 0],
    ['internal', 'server', 500],
    ['resource-exhausted', 'server', 500],
    ['unknown', 'server', 500],
  ] as const)('maps functions/%s to %s/%d', async (code, kind, status) => {
    const thrown = await invokeError(functionsError(code, 'server says'))
    expect(isApiError(thrown)).toBe(true)
    if (!isApiError(thrown)) return
    expect(thrown.kind).toBe(kind)
    expect(thrown.status).toBe(status)
    expect(thrown.code).toBe(`functions/${code}`)
    expect(thrown.message).toBe('server says')
  })

  // docs/仕様/registry-unavailable.md §4: a bare `unavailable` stays network/0;
  // the details markers upgrade it to the two judged registry states.
  it('upgrades unavailable + registry-unavailable details to registryUnavailable/503', async () => {
    const thrown = await invokeError(
      functionsError('unavailable', 'レジストリに接続できない状態です。', {
        reason: 'registry-unavailable',
        registry: 'kitaqnic',
      }),
    )
    expect(isApiError(thrown) && thrown.kind).toBe('registryUnavailable')
    expect(isApiError(thrown) && thrown.status).toBe(503)
  })

  it('upgrades unavailable + registry-maintenance details to registryMaintenance/503, keeping until', async () => {
    const thrown = await invokeError(
      functionsError('unavailable', 'レジストリがメンテナンス中です。', {
        reason: 'registry-maintenance',
        registry: 'kitaqnic',
        until: '2026-08-30T03:00:00.000Z',
      }),
    )
    expect(isApiError(thrown)).toBe(true)
    if (!isApiError(thrown)) return
    expect(thrown.kind).toBe('registryMaintenance')
    expect(thrown.status).toBe(503)
    expect(thrown.maintenanceUntil).toBe('2026-08-30T03:00:00.000Z')
  })

  it('keeps registryMaintenance without an until (none announced)', async () => {
    const thrown = await invokeError(
      functionsError('unavailable', 'メンテナンス中です。', {
        reason: 'registry-maintenance',
        registry: 'kitaqsign',
        until: null,
      }),
    )
    expect(isApiError(thrown) && thrown.kind).toBe('registryMaintenance')
    expect(isApiError(thrown) && thrown.maintenanceUntil).toBeNull()
  })

  it('falls back to the default wording when the message is just the bare code', async () => {
    const thrown = await invokeError(functionsError('internal', 'internal'))
    expect(isApiError(thrown) && thrown.message).not.toBe('internal')
  })

  it('maps unlisted functions codes to unknown/0', async () => {
    const thrown = await invokeError(functionsError('cancelled', 'stopped'))
    expect(isApiError(thrown) && thrown.kind).toBe('unknown')
    expect(isApiError(thrown) && thrown.status).toBe(0)
  })

  it('passes through well-formed details.fieldErrors', async () => {
    const thrown = await invokeError(
      functionsError('invalid-argument', 'bad input', { fieldErrors: { email: 'ドメインが不正です' } }),
    )
    expect(isApiError(thrown) && thrown.fieldErrors).toEqual({ email: 'ドメインが不正です' })
  })

  it('ignores malformed details.fieldErrors', async () => {
    const thrown = await invokeError(
      functionsError('invalid-argument', 'bad input', { fieldErrors: { email: 42 } }),
    )
    expect(isApiError(thrown) && thrown.fieldErrors).toBeUndefined()
  })

  // The real codebase blames one input with details.field + the message
  // (functions/src/api/httpsErrors.ts: ValidationError / authInfoMismatch).
  it('folds details.field + message into fieldErrors', async () => {
    const thrown = await invokeError(
      functionsError('invalid-argument', '認証コードが違うようです。', { field: 'authInfo' }),
    )
    expect(isApiError(thrown) && thrown.fieldErrors).toEqual({
      authInfo: '認証コードが違うようです。',
    })
  })

  it('ignores details.field when the server sent no message to attach', async () => {
    const thrown = await invokeError(
      functionsError('invalid-argument', 'invalid-argument', { field: 'authInfo' }),
    )
    expect(isApiError(thrown) && thrown.fieldErrors).toBeUndefined()
  })

  it('wraps non-Firebase errors as unknown/0 with the cause kept', async () => {
    const cause = new Error('boom')
    const thrown = await invokeError(cause)
    expect(isApiError(thrown)).toBe(true)
    if (!isApiError(thrown)) return
    expect(thrown.kind).toBe('unknown')
    expect(thrown.status).toBe(0)
    expect(thrown.cause).toBe(cause)
  })

  it('rejects immediately with the abort reason when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(invoke('anyFn', {}, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    )
    expect(callableMock).not.toHaveBeenCalled()
  })

  it('rejects with the abort reason (not an ApiError) on mid-flight abort', async () => {
    callableMock.mockReturnValueOnce(new Promise(() => {}))
    const controller = new AbortController()
    const pending = invoke('anyFn', {}, { signal: controller.signal })
    controller.abort()
    try {
      await pending
      throw new Error('expected invoke to reject')
    } catch (thrown) {
      expect(thrown).toBe(controller.signal.reason)
      expect(isApiError(thrown)).toBe(false)
    }
  })
})
