/**
 * カナ欄の受け入れ範囲の回帰テスト。
 *
 * この画面の目的は「漢字・カナを持たない会員も登録を完了できること」なので、
 * ローマ字が通ることと、読みの欄としての意味（ひらがな・漢字を弾く）が
 * 両立していることを、両方向から固定しておく。
 */
import { describe, expect, it } from 'vitest'
import { accountSchema } from './accountSchema'
import { KANA_OR_LATIN_HAS_LETTER, KANA_OR_LATIN_PATTERN } from './nameRules'

function acceptsKana(value: string): boolean {
  return KANA_OR_LATIN_PATTERN.test(value) && KANA_OR_LATIN_HAS_LETTER.test(value)
}

describe('nameKana: 受け付ける表記', () => {
  it.each([
    ['カタカナ', 'ヤマダ タロウ'],
    ['カタカナ＋中点', 'ヤマダ・タロウ'],
    ['長音', 'サトー'],
    ['ローマ字', 'John Smith'],
    ['アクセント付き', 'José Álvarez'],
    ['ウムラウト', 'Müller'],
    ['ベトナム語表記', 'Nguyễn Văn A'],
    // 'e' + U+0301。macOS や一部IMEはこの分解済みの形で渡してくる。
    ['分解済み(NFD)のアクセント', 'Jos\u0065\u0301'],
    ['アポストロフィ', "O'Brien"],
    ['ハイフン', 'Jean-Luc Picard'],
    ['イニシャルのピリオド', 'J. R. Tolkien'],
  ])('%s を受け付ける: %s', (_label, value) => {
    expect(acceptsKana(value)).toBe(true)
  })
})

describe('nameKana: 受け付けない表記', () => {
  it.each([
    ['ひらがな', 'やまだ たろう'],
    ['漢字', '山田 太郎'],
    ['数字混じり', 'Taro123'],
    ['半角カナ', 'ﾔﾏﾀﾞ'],
    ['区切り記号だけ', '・・'],
    ['空白だけ', '   '],
  ])('%s を受け付けない: %s', (_label, value) => {
    expect(acceptsKana(value)).toBe(false)
  })
})

describe('accountSchema', () => {
  const base = {
    name: 'John Smith',
    nameKana: 'John Smith',
    email: 'john@example.com',
    password: 'password123',
    passwordConfirm: 'password123',
    agreeTerms: true,
  }

  it('漢字を持たない会員をローマ字だけで登録できる', () => {
    expect(accountSchema.safeParse(base).success).toBe(true)
  })

  it('名前（漢字）欄はローマ字でも漢字でも通る', () => {
    expect(accountSchema.safeParse({ ...base, name: '山田 太郎', nameKana: 'ヤマダ タロウ' }).success).toBe(true)
  })

  it('名前（カナ）にひらがなを入れると理由付きで弾く', () => {
    const result = accountSchema.safeParse({ ...base, nameKana: 'やまだ' })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path[0] === 'nameKana')).toBe(true)
  })
})
