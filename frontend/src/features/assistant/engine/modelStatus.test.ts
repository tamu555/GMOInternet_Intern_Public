import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_CONFIG, ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY, DOWNLOAD_LOCK_TTL_MS } from '../config/assistantConfig'
import {
  acquireDownloadLock,
  currentModelVersionKey,
  detectWebGpu,
  hasEnoughStorage,
  isDownloadLockedByOtherTab,
  isSlowConnection,
  modelIdFromVersionKey,
  needsCacheRefresh,
  nextStatusAfterChecking,
  readDownloadConsent,
  readDownloadLock,
  releaseDownloadLock,
  saveDownloadConsent,
} from './modelStatus'

function setConnection(value: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, 'connection', { value, configurable: true })
}

beforeEach(() => {
  window.localStorage.clear()
  setConnection(undefined)
})

describe('nextStatusAfterChecking', () => {
  const base = {
    assistantEnabled: true,
    webGpuAvailable: true,
    enoughStorage: true,
    slowConnection: false,
    consentGiven: false,
    cached: false,
    lockedByOtherTab: false,
  }

  it('goes to UNSUPPORTED when assistant is disabled', () => {
    expect(nextStatusAfterChecking({ ...base, assistantEnabled: false })).toEqual({ status: 'UNSUPPORTED', errorKind: null })
  })

  it('goes to UNSUPPORTED when WebGPU is unavailable', () => {
    expect(nextStatusAfterChecking({ ...base, webGpuAvailable: false })).toEqual({ status: 'UNSUPPORTED', errorKind: null })
  })

  it('goes to ERROR with insufficient_storage, no retry semantics implied', () => {
    expect(nextStatusAfterChecking({ ...base, enoughStorage: false })).toEqual({ status: 'ERROR', errorKind: 'insufficient_storage' })
  })

  it('goes to AWAITING_CONSENT on a slow connection without prior consent, uncached', () => {
    expect(nextStatusAfterChecking({ ...base, slowConnection: true, consentGiven: false })).toEqual({
      status: 'AWAITING_CONSENT',
      errorKind: null,
    })
  })

  it('goes to DOWNLOADING otherwise', () => {
    expect(nextStatusAfterChecking(base)).toEqual({ status: 'DOWNLOADING', errorKind: null })
  })

  it('a cached model skips the slow-connection consent gate entirely', () => {
    expect(nextStatusAfterChecking({ ...base, slowConnection: true, consentGiven: false, cached: true })).toEqual({
      status: 'DOWNLOADING',
      errorKind: null,
    })
  })

  it('an uncached model stays at CHECKING while another tab holds the download lock', () => {
    expect(nextStatusAfterChecking({ ...base, lockedByOtherTab: true })).toEqual({ status: 'CHECKING', errorKind: null })
  })
})

describe('hasEnoughStorage', () => {
  const required = ASSISTANT_CONFIG.model.downloadBytes * 1.5

  it('is true at exactly the 1.5x boundary', () => {
    expect(hasEnoughStorage(required, 0)).toBe(true)
  })

  it('is false one byte under the boundary', () => {
    expect(hasEnoughStorage(required - 1, 0)).toBe(false)
  })

  it('is true when the Storage API is unavailable (null quota/usage)', () => {
    expect(hasEnoughStorage(null, null)).toBe(true)
    expect(hasEnoughStorage(null, 0)).toBe(true)
    expect(hasEnoughStorage(required, null)).toBe(true)
  })
})

describe('isSlowConnection', () => {
  it('is false when navigator.connection is absent', () => {
    setConnection(undefined)
    expect(isSlowConnection()).toBe(false)
  })

  it('is true when saveData is true', () => {
    setConnection({ saveData: true })
    expect(isSlowConnection()).toBe(true)
  })

  it.each(['slow-2g', '2g', '3g'])('is true for effectiveType %s', (effectiveType) => {
    setConnection({ effectiveType })
    expect(isSlowConnection()).toBe(true)
  })

  it('is false for effectiveType 4g', () => {
    setConnection({ effectiveType: '4g' })
    expect(isSlowConnection()).toBe(false)
  })
})

describe('download consent', () => {
  it('round-trips a saved consent', () => {
    expect(readDownloadConsent()).toBe(false)
    saveDownloadConsent()
    expect(readDownloadConsent()).toBe(true)
  })

  it('never throws when localStorage.setItem is unavailable (private mode)', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveDownloadConsent()).not.toThrow()
    spy.mockRestore()
  })

  it('never throws when localStorage.getItem is unavailable', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => readDownloadConsent()).not.toThrow()
    expect(readDownloadConsent()).toBe(false)
    spy.mockRestore()
  })
})

describe('download lock', () => {
  const now = 1_000_000

  it('acquires when there is no existing lock', () => {
    expect(acquireDownloadLock('tab-a', now)).toBe(true)
    expect(readDownloadLock()).toEqual({ tabId: 'tab-a', startedAt: now })
  })

  it('re-acquires when the same tab already holds it', () => {
    acquireDownloadLock('tab-a', now)
    expect(acquireDownloadLock('tab-a', now + 1000)).toBe(true)
  })

  it('is denied to a different tab while the lock is live', () => {
    acquireDownloadLock('tab-a', now)
    expect(acquireDownloadLock('tab-b', now + 1000)).toBe(false)
    expect(isDownloadLockedByOtherTab('tab-b', now + 1000)).toBe(true)
  })

  it('a different tab may acquire once the lock has expired', () => {
    acquireDownloadLock('tab-a', now)
    const after = now + DOWNLOAD_LOCK_TTL_MS + 1
    expect(isDownloadLockedByOtherTab('tab-b', after)).toBe(false)
    expect(acquireDownloadLock('tab-b', after)).toBe(true)
    expect(readDownloadLock()).toEqual({ tabId: 'tab-b', startedAt: after })
  })

  it('release only clears the lock if this tab still owns it', () => {
    acquireDownloadLock('tab-a', now)
    releaseDownloadLock('tab-b')
    expect(readDownloadLock()).not.toBeNull()
    releaseDownloadLock('tab-a')
    expect(readDownloadLock()).toBeNull()
  })

  it('readDownloadLock discards a malformed record', () => {
    window.localStorage.setItem(ASSISTANT_DOWNLOAD_LOCK_STORAGE_KEY, JSON.stringify({ tabId: 42 }))
    expect(readDownloadLock()).toBeNull()
  })
})

describe('needsCacheRefresh', () => {
  it('is false when no record exists yet (first run, not a refresh)', () => {
    expect(needsCacheRefresh(null)).toBe(false)
  })

  it('is false when the record matches the current model version key', () => {
    expect(needsCacheRefresh(currentModelVersionKey())).toBe(false)
  })

  it('is true when the record names a different model version', () => {
    expect(needsCacheRefresh('some-old-model@0')).toBe(true)
  })
})

describe('modelIdFromVersionKey', () => {
  it('strips the trailing @version', () => {
    expect(modelIdFromVersionKey('Qwen3-0.6B-q4f16_1-MLC@1')).toBe('Qwen3-0.6B-q4f16_1-MLC')
  })

  it('returns the key unchanged when there is no @', () => {
    expect(modelIdFromVersionKey('no-version-marker')).toBe('no-version-marker')
  })
})

describe('detectWebGpu', () => {
  it('resolves { available: false } in jsdom without throwing', async () => {
    await expect(detectWebGpu()).resolves.toEqual({ available: false, shaderF16: false })
  })
})
