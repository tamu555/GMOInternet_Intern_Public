import { describe, expect, it } from 'vitest'
import { EMAIL_INVALID_MESSAGE, validateEmail, validateLoginForm } from './validation'

describe('validateLoginForm', () => {
  it('accepts any non-empty password, since length policy is a registration concern', () => {
    const errors = validateLoginForm({ email: 'demo@example.com', password: 'x' })
    expect(errors).toEqual({})
  })

  it('reports a missing password', () => {
    const errors = validateLoginForm({ email: 'demo@example.com', password: '' })
    expect(errors.password).toBeDefined()
  })

  it('reports a malformed address on the email field', () => {
    const errors = validateLoginForm({ email: 'demo', password: 'x' })
    expect(errors.email).toBe(EMAIL_INVALID_MESSAGE)
  })

  it('no longer restricts the domain — that is a registration rule', () => {
    const errors = validateLoginForm({ email: 'taro@gmail.com', password: 'x' })
    expect(errors).toEqual({})
  })
})

describe('validateEmail', () => {
  it.each(['demo@example.com', 'taro.yamada+tag@mail.example.co.jp', 'a@b.io'])(
    'accepts %s',
    (email) => {
      expect(validateEmail(email)).toBeUndefined()
    },
  )

  it.each(['demo', 'demo@', '@example.com', 'demo@example', 'demo@@example.com', 'demo@example.'])(
    'rejects %s',
    (email) => {
      expect(validateEmail(email)).toBe(EMAIL_INVALID_MESSAGE)
    },
  )

  it('asks for input rather than shouting at an empty field', () => {
    expect(validateEmail('   ')).toBe('メールアドレスを入力してください。')
  })

  it('trims surrounding whitespace before judging', () => {
    expect(validateEmail('  demo@example.com  ')).toBeUndefined()
  })
})
