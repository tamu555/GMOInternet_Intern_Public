import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUTHENTICATED_PATH } from '../config'
import { clearReturnTo, isSafeReturnPath, resolveReturnTo, saveReturnTo } from './returnTo'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('isSafeReturnPath', () => {
  it('accepts an in-app absolute path', () => {
    expect(isSafeReturnPath('/easy/goal')).toBe(true)
  })

  it('rejects a protocol-relative URL (open redirect)', () => {
    expect(isSafeReturnPath('//evil.example/phish')).toBe(false)
  })

  it('rejects an absolute URL', () => {
    expect(isSafeReturnPath('https://evil.example')).toBe(false)
  })

  it('rejects the auth screens themselves', () => {
    expect(isSafeReturnPath('/login')).toBe(false)
    expect(isSafeReturnPath('/register')).toBe(false)
  })

  it('rejects empty input', () => {
    expect(isSafeReturnPath(null)).toBe(false)
  })
})

describe('resolveReturnTo', () => {
  it('prefers the router-provided path', () => {
    saveReturnTo('/domains')
    expect(resolveReturnTo('/easy/goal')).toBe('/easy/goal')
  })

  it('falls back to the stored path', () => {
    saveReturnTo('/domains')
    expect(resolveReturnTo(undefined)).toBe('/domains')
  })

  it('falls back to the dashboard when nothing was recorded', () => {
    expect(resolveReturnTo(undefined)).toBe(DEFAULT_AUTHENTICATED_PATH)
  })

  it('does not consume the stored path (resolution must be side-effect free)', () => {
    saveReturnTo('/domains')
    resolveReturnTo(undefined)
    expect(resolveReturnTo(undefined)).toBe('/domains')
  })

  it('never stores an unsafe path', () => {
    saveReturnTo('//evil.example')
    expect(resolveReturnTo(undefined)).toBe(DEFAULT_AUTHENTICATED_PATH)
  })

  it('can be cleared explicitly', () => {
    saveReturnTo('/domains')
    clearReturnTo()
    expect(resolveReturnTo(undefined)).toBe(DEFAULT_AUTHENTICATED_PATH)
  })
})
