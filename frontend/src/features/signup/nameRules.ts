/**
 * 会員の氏名（name / nameKana）に共通の入力ルール。
 *
 * ⚠️ 以前はカナ欄をカタカナのみに縛っていたため、漢字やカナを持たない
 * 会員（外国籍の方など）が会員登録を完了できなかった。カナ欄は
 * 「カタカナ **または** ラテン文字（ローマ字）」を受け付ける。
 *
 * ラテン文字はアクセント付き（é / ü / ñ）とベトナム語表記（ễ / ạ）まで含める。
 * A-Za-z だけに絞ると、英語圏の名前だけ通ってフランス語・ドイツ語・
 * ベトナム語の名前が弾かれる — 直したはずの不具合がそのまま残る。
 * ひらがな・漢字・数字は引き続き受け付けない（読みの欄としての意味を保つため）。
 *
 * ⚠️ この2つの正規表現は functions/src/auth/profileSchema.ts と同一定義。
 * 片方だけ直すと、画面を通ったのにサーバで弾かれる状態になる。
 */

/** バックエンドの profileSchema.ts と同じ上限。 */
export const NAME_MAX_LENGTH = 100

/* --- カナ欄に許可する文字。部品ごとに名前を付けて組み立てる。
       functions/src/auth/profileSchema.ts に同じ部品が並んでいる。 --- */

/** ァ-ヶ。半角カナは対象外（従来どおり）。 */
const KATAKANA_LETTERS = '\\u30A1-\\u30F6'
/** ・ ー ヽ ヾ (U+30FB..U+30FE)。 */
const KATAKANA_MARKS = '\\u30FB-\\u30FE'
/** ラテン文字。× (U+00D7) と ÷ (U+00F7) を外すため範囲を3つに割っている。
    U+1E00-U+1EFF はベトナム語表記（ễ / ạ）。 */
const LATIN_LETTERS = "A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF"
/** 結合発音記号。macOS や一部IMEは分解済み(NFD)で渡してくるため、
    "José" が "e" + U+0301 として届く。これが無いと弾いてしまう。 */
const COMBINING_MARKS = '\\u0300-\\u036F'
/** 半角/全角スペースと、名前に使う記号（. \' \u2019 -）。 */
const NAME_SEPARATORS = "\\s\\u3000.'\\u2019-"

export const KANA_OR_LATIN_PATTERN = new RegExp(
  `^[${KATAKANA_LETTERS}${KATAKANA_MARKS}${LATIN_LETTERS}` +
    `${COMBINING_MARKS}${NAME_SEPARATORS}]+$`,
)

/** 区切り記号だけの入力（「・・」「 - 」など）を弾くための「文字が1つはある」判定。 */
export const KANA_OR_LATIN_HAS_LETTER = new RegExp(`[${KATAKANA_LETTERS}${LATIN_LETTERS}]`)

export const KANA_FORMAT_MESSAGE = 'カタカナ、またはローマ字（英字）で入力してください。'

/* --- 画面表示（ラベル・入力例）。3画面で同じ文言を使う。 --- */

export const NAME_LABEL = '名前（漢字）'
export const NAME_KANA_LABEL = '名前（カナ）'

export const NAME_PLACEHOLDER = '山田 太郎'
export const NAME_KANA_PLACEHOLDER = 'ヤマダ タロウ'
