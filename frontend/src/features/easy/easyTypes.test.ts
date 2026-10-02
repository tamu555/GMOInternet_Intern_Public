import { describe, expect, it } from 'vitest'
import {
  EASY_STEPS,
  EMPTY_EASY_SESSION,
  canEnterEasyStep,
  completedStepsOf,
  furthestReachableStep,
  isEasyStepCompleted,
  type EasySession,
} from './easyTypes'

function sessionWith(patch: Partial<EasySession>): EasySession {
  return { ...EMPTY_EASY_SESSION, ...patch }
}

describe('furthestReachableStep', () => {
  it('starts at the goal step for an empty session', () => {
    expect(furthestReachableStep(EMPTY_EASY_SESSION)).toBe('goal')
  })

  it('advances one step per completed input', () => {
    expect(furthestReachableStep(sessionWith({ purpose: 'shop' }))).toBe('name')
    expect(furthestReachableStep(sessionWith({ purpose: 'shop', label: 'my-shop' }))).toBe('tld')
    expect(furthestReachableStep(sessionWith({ purpose: 'shop', label: 'my-shop', tld: '.com' }))).toBe('confirm')
  })

  it('sends a session that already has an order to the DNS step', () => {
    const session = sessionWith({
      purpose: 'shop',
      label: 'my-shop',
      tld: '.com',
      orderId: 'ord-000001',
      domainName: 'my-shop.com',
    })
    expect(furthestReachableStep(session)).toBe('dns')
  })

  it('stays on the DNS step once everything is done', () => {
    const session = sessionWith({
      purpose: 'shop',
      label: 'my-shop',
      tld: '.com',
      orderId: 'ord-000001',
      domainName: 'my-shop.com',
      dnsPlan: 'later',
    })
    expect(furthestReachableStep(session)).toBe('dns')
  })
})

describe('canEnterEasyStep', () => {
  it('blocks steps whose input is not there yet', () => {
    expect(canEnterEasyStep(EMPTY_EASY_SESSION, 'tld')).toBe(false)
    expect(canEnterEasyStep(EMPTY_EASY_SESSION, 'confirm')).toBe(false)
  })

  /* 支払い画面は「注文がまだ無い」状態でこそ開ける必要がある。
     完了判定をそのまま入場条件に使うと、ここが永久に開かなくなる。 */
  it('lets the payment step open before an order exists', () => {
    const session = sessionWith({ purpose: 'shop', label: 'my-shop', tld: '.com' })
    expect(canEnterEasyStep(session, 'payment')).toBe(true)
    expect(isEasyStepCompleted(session, 'payment')).toBe(false)
  })

  it('blocks the DNS step until an order was actually issued', () => {
    const session = sessionWith({ purpose: 'shop', label: 'my-shop', tld: '.com' })
    expect(canEnterEasyStep(session, 'dns')).toBe(false)
  })
})

describe('completedStepsOf', () => {
  /**
   * 仕様 §6.2.3: 完了は保存フラグではなく実データから導く。
   * セッションに「支払った」旗そのものが存在しないことをここで固定する。
   */
  it('never reports payment as done without an order id', () => {
    const session = sessionWith({ purpose: 'shop', label: 'my-shop', tld: '.com' })
    expect(completedStepsOf(session)).toEqual(['goal', 'name', 'tld'])
  })

  it('reports every step once the wizard is finished', () => {
    const session = sessionWith({
      purpose: 'shop',
      label: 'my-shop',
      tld: '.com',
      orderId: 'ord-000001',
      domainName: 'my-shop.com',
      dnsPlan: 'web',
    })
    expect(completedStepsOf(session)).toEqual(EASY_STEPS.map((step) => step.id))
  })
})
