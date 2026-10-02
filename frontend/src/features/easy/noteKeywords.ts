/**
 * 自由入力（「どんなことに使う予定ですか？」）から、ドメイン名の種にできる
 * 英単語を引くための**手書きの対訳表**。
 *
 * ⚠ これはローマ字への機械変換ではない。「パン屋 → panya」のように読みを
 * 推測して綴りを作る処理は、根拠のない語を発明することになるので easyNameApi.ts
 * は一貫して拒否している（同ファイルの ⚠ コメントを参照）。ここでやっているのは
 * 人が 1 件ずつ書いた表の引き当てだけで、**表に載っている語しか返さない**。
 * 載っていない語からは何も作らないので、捏造にはならない。
 *
 * TODO(backend): この表は提案APIが無いあいだの穴埋め。用途の文章をどう解釈して
 * 名前に落とすかは本来サーバ側の提案エンジンの仕事で、実装されたらこの表ごと
 * 不要になる（easyNameApi.ts の TODO(backend) と対になっている）。
 */

export type NoteKeyword = {
  /** 文章の中に現れうる日本語（NFKC 正規化後の表記で書く）。 */
  readonly ja: string
  /** ドメインラベルに使う英単語。小文字・英数字のみ。 */
  readonly en: string
}

/**
 * ⚠ **並び順＝優先順位**。上にあるものほど先に候補へ回る。
 *
 * もう 1 つ順番が効くところがあって、一致した箇所は原文から取り除きながら
 * 進むので、**長い語・具体的な語を先に置く**こと。「自転車」を「車」より先に
 * 置いてあるのはそのため（逆だと自転車の店が car になる）。
 */
export const NOTE_KEYWORDS: readonly NoteKeyword[] = [
  // 業種（具体的なものから）。
  { ja: 'ベーカリー', en: 'bakery' },
  { ja: 'パン屋', en: 'bakery' },
  { ja: '喫茶', en: 'cafe' },
  { ja: 'カフェ', en: 'cafe' },
  { ja: 'レストラン', en: 'restaurant' },
  { ja: '食堂', en: 'diner' },
  { ja: '居酒屋', en: 'tavern' },
  { ja: '美容室', en: 'salon' },
  { ja: 'サロン', en: 'salon' },
  { ja: '歯科', en: 'dental' },
  { ja: 'クリニック', en: 'clinic' },
  { ja: '病院', en: 'clinic' },
  { ja: 'フィットネス', en: 'fitness' },
  { ja: 'ジム', en: 'fitness' },
  { ja: 'スクール', en: 'school' },
  { ja: '教室', en: 'school' },
  { ja: '塾', en: 'academy' },
  { ja: '保育', en: 'kids' },
  { ja: '不動産', en: 'estate' },
  { ja: '建築', en: 'build' },
  { ja: '工務店', en: 'build' },
  { ja: '農園', en: 'farm' },
  { ja: '農家', en: 'farm' },
  { ja: '花屋', en: 'flower' },
  { ja: '書店', en: 'book' },
  { ja: '本屋', en: 'book' },
  { ja: 'アパレル', en: 'wear' },
  { ja: '自転車', en: 'bike' },
  { ja: 'ペット', en: 'pet' },
  // 分野・テーマ。
  { ja: 'デザイン', en: 'design' },
  { ja: '写真', en: 'photo' },
  { ja: '音楽', en: 'music' },
  { ja: 'ダンス', en: 'dance' },
  { ja: 'アート', en: 'art' },
  { ja: 'ハンドメイド', en: 'craft' },
  { ja: '旅行', en: 'travel' },
  { ja: 'ゲーム', en: 'game' },
  { ja: 'ブログ', en: 'blog' },
  { ja: 'ニュース', en: 'news' },
  { ja: 'イベント', en: 'event' },
  { ja: '祭', en: 'festival' },
  { ja: '料理', en: 'food' },
  { ja: '車', en: 'car' },
  { ja: '服', en: 'wear' },
  // 一般語（業種が取れなかったときの受け皿なので下に置く）。
  { ja: 'ショップ', en: 'shop' },
  { ja: 'お店', en: 'shop' },
  { ja: '会社', en: 'company' },
  { ja: '事務所', en: 'office' },
  { ja: '工房', en: 'studio' },
  // 地名（業種と組み合わせると一気に「自分のもの」になる語）。
  { ja: '北九州', en: 'kitakyushu' },
  { ja: '九州', en: 'kyushu' },
  { ja: '東京', en: 'tokyo' },
  { ja: '大阪', en: 'osaka' },
  { ja: '京都', en: 'kyoto' },
  { ja: '福岡', en: 'fukuoka' },
  { ja: '名古屋', en: 'nagoya' },
  { ja: '横浜', en: 'yokohama' },
  { ja: '神戸', en: 'kobe' },
  { ja: '札幌', en: 'sapporo' },
  { ja: '沖縄', en: 'okinawa' },
]

/**
 * 対訳表に載っている語だけを、表の順番で拾う。
 *
 * 一致した箇所を取り除きながら進むのは、短い語が長い語の中で二重に当たるのを
 * 防ぐため（「自転車」で bike を拾ったあと、残りに「車」は残らない）。
 * 乱数も時刻も使わない — 同じ文章からは常に同じ並びが返る。
 */
export function japaneseKeywordsFromNote(note: string): string[] {
  let rest = note.normalize('NFKC')
  const found: string[] = []
  for (const { ja, en } of NOTE_KEYWORDS) {
    if (!rest.includes(ja)) continue
    rest = rest.split(ja).join('\n')
    if (!found.includes(en)) found.push(en)
  }
  return found
}
