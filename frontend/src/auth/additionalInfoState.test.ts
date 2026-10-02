/**
 * Unit tests for the sessionStorage-backed "pending Google additional info"
 * marker (architecture doc §1.1/§1.3: set by AuthProvider.loginWithGoogle()
 * on `additional_info_required`, read by <RequireAdditionalInfo>, cleared by
 * GoogleAdditionalInfoPage after a successful submit + second sessionLogin).
 *
 * Mirrors tokenStorage.ts's tested contract (save/read/clear round trip) but
 * additionally asserts the sessionStorage-specific promise: it must survive
 * whatever a same-tab reload does (a fresh read() reflecting whatever is in
 * sessionStorage) while a full storage wipe must not leave a stale in-memory
 * value behind.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAdditionalInfoPending,
  readAdditionalInfoPending,
  saveAdditionalInfoPending,
} from './additionalInfoState'

const PENDING = { uid: 'google-uid-1', email: 'taro@example.com' }

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('additionalInfoState', () => {
  it('returns null when nothing has been saved', () => {
    expect(readAdditionalInfoPending()).toBeNull()
  })

  it('round-trips a saved marker', () => {
    saveAdditionalInfoPending(PENDING)
    expect(readAdditionalInfoPending()).toEqual(PENDING)
  })

  it('clears the marker so a subsequent read returns null', () => {
    saveAdditionalInfoPending(PENDING)
    clearAdditionalInfoPending()
    expect(readAdditionalInfoPending()).toBeNull()
  })

  it('persists to window.sessionStorage, not an in-memory-only value (survives a same-tab reload)', () => {
    saveAdditionalInfoPending(PENDING)
    // A real page reload tears down the JS module and re-runs it from
    // scratch; the only thing that can possibly survive that is whatever is
    // actually written into Web Storage. If save() only kept the marker in a
    // module-level variable, sessionStorage itself would still be empty here.
    expect(window.sessionStorage.length).toBeGreaterThan(0)
  })

  it('does not survive a manual/full sessionStorage clear (no stale in-memory fallback)', () => {
    saveAdditionalInfoPending(PENDING)
    expect(readAdditionalInfoPending()).toEqual(PENDING)

    // Simulates the browser/user clearing site storage out from under the
    // module - distinct from calling clearAdditionalInfoPending() itself.
    window.sessionStorage.clear()

    expect(readAdditionalInfoPending()).toBeNull()
  })

  it('overwrites a previously saved marker with the latest save', () => {
    saveAdditionalInfoPending(PENDING)
    const other = { uid: 'google-uid-2', email: 'hanako@example.com' }
    saveAdditionalInfoPending(other)
    expect(readAdditionalInfoPending()).toEqual(other)
  })

  it('ignores malformed JSON left behind under its storage key', () => {
    window.sessionStorage.setItem('registrar.auth.additionalInfoPending', '{not json')
    expect(readAdditionalInfoPending()).toBeNull()
  })
})
