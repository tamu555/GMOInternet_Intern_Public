import { describe, expect, it } from 'vitest'
import { messageForEppCode } from './eppResultMessages'

describe('EPP result.code -> wording (spec §6.7, the single mapping module)', () => {
  it('maps the four error codes of the spec table', () => {
    expect(messageForEppCode(2302)).toBe('このドメインはすでに使われています。')
    expect(messageForEppCode(2303)).toBe('対象が見つかりませんでした。')
    expect(messageForEppCode(2202)).toBe('認証コードが違うようです。移管元でもう一度確認してください。')
    expect(messageForEppCode(2306)).toBe('この操作は現在の状態では行えません。')
  })

  it('returns undefined for success (1000), unknown codes, and absence', () => {
    expect(messageForEppCode(1000)).toBeUndefined()
    expect(messageForEppCode(9999)).toBeUndefined()
    expect(messageForEppCode(undefined)).toBeUndefined()
  })
})
