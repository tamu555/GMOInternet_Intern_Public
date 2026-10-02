import { beforeEach, describe, expect, it } from 'vitest'
import {
  EASY_DRAFT_TTL_MS,
  GUEST_SCOPE,
  clearEasyDrafts,
  clearEasySession,
  easyStorageKey,
  hasPendingEasySession,
  isEmptyEasySession,
  isExpiredEasySession,
  loadEasySession,
  saveEasySession,
} from './easyStorage'
import { EMPTY_EASY_SESSION } from './easyTypes'

/** `updatedAt` が `ageMs` 前の下書き。 */
function draftAged(ageMs: number, overrides: Partial<typeof EMPTY_EASY_SESSION> = {}) {
  return {
    ...EMPTY_EASY_SESSION,
    purpose: 'shop' as const,
    label: 'my-shop',
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('loadEasySession', () => {
  it('round-trips a saved session', () => {
    const session = { ...EMPTY_EASY_SESSION, purpose: 'shop' as const, label: 'my-shop', tld: '.com' }
    saveEasySession(GUEST_SCOPE, session)
    expect(loadEasySession(GUEST_SCOPE)).toEqual(session)
  })

  it('returns the empty session when nothing was saved', () => {
    expect(loadEasySession('u1')).toEqual(EMPTY_EASY_SESSION)
  })

  it('survives a corrupted entry', () => {
    window.localStorage.setItem(easyStorageKey('u1'), '{ not json')
    expect(loadEasySession('u1')).toEqual(EMPTY_EASY_SESSION)
  })

  /**
   * localStorage の中身はユーザーが書き換えられる。domainName は callable の
   * 引数に、orderId は navigate() のパスに入るので、形が合わないものは
   * 「保存が無い」として扱う。
   */
  it('drops values whose shape does not match', () => {
    window.localStorage.setItem(
      easyStorageKey('u1'),
      JSON.stringify({
        purpose: 'not-a-purpose',
        label: '../../etc/passwd',
        tld: 'javascript:alert(1)',
        orderId: '../admin',
        domainName: '//evil.example',
        years: 9999,
        dnsPlan: 'whatever',
        dnsServiceId: '<script>',
      }),
    )

    const restored = loadEasySession('u1')
    expect(restored.purpose).toBeNull()
    expect(restored.label).toBe('')
    expect(restored.tld).toBe('')
    expect(restored.orderId).toBeNull()
    expect(restored.domainName).toBe('')
    expect(restored.years).toBe(EMPTY_EASY_SESSION.years)
    expect(restored.dnsPlan).toBeNull()
    expect(restored.dnsServiceId).toBeNull()
  })

  it('keeps scopes separate so one member never sees another draft', () => {
    saveEasySession('u1', { ...EMPTY_EASY_SESSION, label: 'first' })
    expect(loadEasySession('u2')).toEqual(EMPTY_EASY_SESSION)
  })
})

describe('isEmptyEasySession / hasPendingEasySession', () => {
  it('treats a fresh session as empty', () => {
    expect(isEmptyEasySession(EMPTY_EASY_SESSION)).toBe(true)
    expect(hasPendingEasySession()).toBe(false)
  })

  it('detects a draft in any scope', () => {
    saveEasySession('u1', { ...EMPTY_EASY_SESSION, purpose: 'blog' })
    expect(hasPendingEasySession()).toBe(true)
    clearEasySession('u1')
    expect(hasPendingEasySession()).toBe(false)
  })
})

/**
 * トップページに戻ってきたときの破棄（2026-08-28）。
 * 「入力途中の下書きは全部消す / 注文発行済みだけは残す」の 2 点が契約。
 */
describe('clearEasyDrafts', () => {
  it('drops every in-progress draft, in every scope', () => {
    saveEasySession(GUEST_SCOPE, { ...EMPTY_EASY_SESSION, purpose: 'blog', label: 'guest-draft' })
    saveEasySession('u1', { ...EMPTY_EASY_SESSION, purpose: 'shop', label: 'member-draft' })

    clearEasyDrafts()

    expect(loadEasySession(GUEST_SCOPE)).toEqual(EMPTY_EASY_SESSION)
    expect(loadEasySession('u1')).toEqual(EMPTY_EASY_SESSION)
    expect(hasPendingEasySession()).toBe(false)
  })

  /* 注文が出たあとの下書きは「入力内容」ではなく購入済みドメインの設定途中。
     消すと /easy からつなぐ設定へ戻る手がかりが無くなるので残す。 */
  it('keeps a draft whose order was already placed', () => {
    const ordered = {
      ...EMPTY_EASY_SESSION,
      purpose: 'shop' as const,
      label: 'bought',
      tld: '.com',
      orderId: 'ord_1',
      domainName: 'bought.com',
    }
    saveEasySession('u1', ordered)
    saveEasySession(GUEST_SCOPE, { ...EMPTY_EASY_SESSION, purpose: 'blog', label: 'draft' })

    clearEasyDrafts()

    expect(loadEasySession('u1')).toEqual(ordered)
    expect(loadEasySession(GUEST_SCOPE)).toEqual(EMPTY_EASY_SESSION)
  })

  it('leaves unrelated localStorage keys alone', () => {
    window.localStorage.setItem('registrar.mock.scenario', '{"domainSearch":"all-taken"}')
    saveEasySession('u1', { ...EMPTY_EASY_SESSION, purpose: 'blog' })

    clearEasyDrafts()

    expect(window.localStorage.getItem('registrar.mock.scenario')).toBe('{"domainSearch":"all-taken"}')
  })
})


/**
 * 下書きの寿命（issue #91）。localStorage は放っておけば無期限に残るので、
 * 数日前にやめた人が `/easy` を開くと、覚えていない目的・覚えていない名前の
 * 「2/6」から再開させられる。
 */
describe('下書きの寿命', () => {
  it('期限内の下書きはそのまま読める', () => {
    const session = draftAged(EASY_DRAFT_TTL_MS - 60_000)
    saveEasySession('u1', session)
    expect(loadEasySession('u1')).toEqual(session)
  })

  it('期限切れの下書きは読み出しの時点で捨てる', () => {
    saveEasySession('u1', draftAged(EASY_DRAFT_TTL_MS + 60_000))

    expect(loadEasySession('u1')).toEqual(EMPTY_EASY_SESSION)
    // 読んだ側が消すので、次に開いたときも同じ答えになる。
    expect(window.localStorage.getItem(easyStorageKey('u1'))).toBeNull()
  })

  /**
   * ⚠️ 注文発行済みは「入力内容」ではなく購入済みドメインの設定途中。消すと
   * `/easy` からつなぐ設定（ステップ6）へ戻る手がかりが無くなる。
   */
  it('注文発行済みの下書きは、どれだけ古くても残す', () => {
    const session = draftAged(EASY_DRAFT_TTL_MS * 30, { orderId: 'ord-1', domainName: 'my-shop.com' })
    saveEasySession('u1', session)

    expect(loadEasySession('u1')).toEqual(session)
    expect(isExpiredEasySession(session)).toBe(false)
  })

  /** いつ書かれたか分からないものは、勝手に消さない側へ倒す。 */
  it('updatedAt が空・不正な下書きは期限切れ扱いにしない', () => {
    expect(isExpiredEasySession({ ...EMPTY_EASY_SESSION, updatedAt: '' })).toBe(false)
    expect(isExpiredEasySession({ ...EMPTY_EASY_SESSION, updatedAt: 'not a date' })).toBe(false)
  })

  it('hasPendingEasySession は期限切れの下書きを「続きがある」と答えない', () => {
    saveEasySession('u1', draftAged(EASY_DRAFT_TTL_MS + 60_000))
    expect(hasPendingEasySession()).toBe(false)
  })
})
