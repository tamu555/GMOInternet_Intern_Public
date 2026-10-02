/**
 * かんたんモードの固定文言。
 *
 * 1 モジュールに集約するのは、既存の `orderMessages.ts` / `domainMessages.ts` と
 * 同じ理由（画面ごとに言い回しがぶれるのを防ぐ）。専門用語は消さずに平易な説明を
 * 併記する — 仕様 §1.4 の「用語を削除せず注釈する。目標は通常モードへの卒業」。
 *
 * 文言の作法（初心者向けの情報設計）:
 *   - 見出しは「〜しますか？」「〜を選びましょう」の短い問いかけ 1 行にする
 *   - ⚠️ 補足は **1 文** まで。2 文目が要るなら、それは畳むか、次の手順へ送る。
 *     読む量そのものが初心者の負担なので、「正確さのために足す 1 文」は
 *     たいてい「読まれないまま画面を重くする 1 文」になる（2026-08-27 の全面圧縮）。
 *   - 同じことを 2 か所で言わない。前の画面で言ったことは繰り返さない。
 *   - 専門語（TLD / DNS / ネームサーバー）は平易な言い換えを先に出し、
 *     用語そのものは小さな補足として添える
 */

export const EASY_MODE_LABEL = 'かんたんモード'
export const NORMAL_MODE_LABEL = '通常モード'

export const EASY_MODE_TAGLINE = '質問に答えるだけで、ドメインの取得と設定まで進められます。'

/** 共通アクション（全ステップ共通のボタン文言）。 */
export const ACTION_BACK = '戻る'
export const ACTION_NEXT = '次へ'
/* 確認画面の「変更」から来たときの主要ボタン。「次へ」のままだと、1 項目直しに
   来た人に「まだ先があるのか」と読ませてしまうので、行き先を名指しする。 */
export const ACTION_BACK_TO_CONFIRM = '確認画面に戻る'

/** ステップ 1: 目的 */
export const GOAL_HEADING = '何に使いますか？'
export const GOAL_LEDE = '選んだ内容に合わせて、名前と末尾のおすすめを用意します。'
/**
 * 畳んだ側の見出し。⚠️ 中身の例を必ず添える — 「ほかの目的から選ぶ」だけだと、
 * メールに使いたい人が開く価値を判断できないまま素通りする。ただし全件は挙げない
 * （3 件を括弧で列挙すると、畳んでいないのと同じ長さになる）。
 */
export const GOAL_MORE_ACTION = 'ほかの目的（メール・イベントなど）'
export const GOAL_POPULAR_BADGE = 'よく選ばれています'
export const GOAL_REQUIRED_ERROR = '用途を1つ選んでください。'
/** ステップ 2: ドメイン名（＝検索画面） */
export const NAME_HEADING = 'ドメイン名を決めましょう'
export const NAME_LEDE = '思いつかないときは、空のまま「検索する」を押してください。'
export const NAME_OWN_INPUT_LABEL = '使いたい名前'
export const NAME_SEARCH_ACTION = '検索する'
export const NAME_SUGGESTIONS_HEADING = 'おすすめの名前'
/**
 * ステップ 2 の後半＝検索結果の画面（/easy/name/results）。
 *
 * 検索フォームと同じ画面に結果を積むのをやめて、結果は別の画面が引き受ける。
 * 押した直後に画面が変わるので「検索が実行された」ことが動きで分かるし、
 * 結果の画面は「選ぶ」ことだけに集中できる（フォームの下に候補が生えてくる形は、
 * どこを見ればいいのかが最後まで分からない）。
 */
export const NAME_RESULTS_HEADING = '検索結果'
export const NAME_RESULTS_LEDE = '使いたい名前を1つ選んで、「次へ」に進んでください。'
/** 結果の画面に残す検索窓のボタン。ここから押すのは常に「やり直し」なので名前を変える。 */
export const NAME_RESEARCH_ACTION = '再検索'
export const NAME_SUGGESTIONS_EMPTY = '候補を作れませんでした。上の入力欄に、使いたい英数字の名前を入れてみてください。'
export const NAME_SUGGESTIONS_LOADING = '候補の空き状況を確認しています…'
export const NAME_MORE_ACTION = 'ほかの候補を見る'
export const NAME_LESS_ACTION = '候補を絞る'
export const NAME_REQUIRED_ERROR = 'ドメイン名を選ぶか、入力してください。'
/** 空き確認がまだ終わっていない状態（＝「確認できませんでした」ではない）。 */
export const NAME_CHECKING_LABEL = '確認中…'
/** 候補が全滅したとき、押せない「次へ」の代わりに理由と次の一手を伝える。 */
export const NAME_ALL_TAKEN_ERROR =
  'この名前は、どの末尾でも取得できませんでした。上の入力欄で別の名前を入れて、もう一度おためしください。'
/** §1.4「用語は消さず併記」。ラベルという語をここで 1 度だけ渡しておく。 */
export const NAME_JARGON_NOTE = '「example.com」でいう example の部分（専門用語でラベル）。'
export const NAME_FAVORITE_ADD = 'お気に入りに追加'
export const NAME_FAVORITE_REMOVE = 'お気に入りから外す'
export const NAME_OWN_BADGE = '入力した名前'
export const NAME_BEST_BADGE = 'おすすめ'
/** EasyNamePage.tsx が参照中。IA刷新のリファクタ完了時に整理してよい。 */
export const NAME_SELECT_ACTION = 'この名前にする'
export const NAME_SELECTED_LABEL = '選択中'
export const NAME_TAKEN_LABEL = '取得済み'
export const NAME_AVAILABLE_LABEL = '取得できます'
export const NAME_UNKNOWN_LABEL = '確認できませんでした'
/** レジストリ接続不能（docs/仕様/registry-unavailable.md §6.9）: メンテナンスと断定しない文言。 */
export const NAME_UNAVAILABLE_LABEL = '一時的に取得できません'
/** レジストリ自身がpollで告知したメンテナンス窓の最中: ここだけはメンテナンスと言い切れる。 */
export const NAME_MAINTENANCE_LABEL = 'メンテナンス中のため取得できません'

/** 検索条件（初期表示では折りたたむ）。 */
export const SEARCH_CONDITIONS_SUMMARY = 'くわしい条件を指定する'
export const SEARCH_NOTE_LABEL = 'どんなことに使う予定ですか？'
export const SEARCH_NOTE_PLACEHOLDER = '例）小さなパン屋のお店紹介ページを作りたい'

/** ステップ 3: TLD（＝ドメインの末尾） */
export const TLD_HEADING = '末尾（.com など）を選びましょう'
export const TLD_LEDE = 'いちばん上がおすすめです。このまま「次へ」でも進めます。'
export const TLD_JARGON_NOTE = '専門用語では TLD（トップレベルドメイン）と呼びます。'
export const TLD_BEST_BADGE = 'いちばんおすすめ'
export const TLD_SORT_SUMMARY = '並び順を変える'
export const TLD_MORE_ACTION = 'ほかの候補を見る'
export const TLD_LESS_ACTION = '候補を絞る'
export const TLD_REQUIRED_ERROR = 'ドメインの末尾を1つ選んでください。'
export const TLD_EMPTY_MESSAGE = '取得できる末尾がありませんでした。前の画面で名前を変えてみてください。'
export const TLD_FIRST_YEAR_LABEL = '初年度'
export const TLD_RENEWAL_LABEL = '2年目以降 毎年'

/**
 * 一覧を「おすすめ3件 → ほか全部 → 選べないもの」の3つの帯に分ける見出し。
 *
 * 2026-08-27: それまでは3件だけ出して残り19件を「ほかの候補を見る」の中に
 * 畳んでいた。畳むと、初心者は「これで全部なのか」「安いものが隠れていないか」を
 * 判断できないまま次へ進んでしまう（通常モードが同じ理由でページャを捨てている
 * ＝ DomainSelectTable.tsx の冒頭コメント）。おすすめ3件という §6.2.4 の要求は
 * 「おすすめ」帯として残し、全一覧は畳まずに横並びの一覧で同時に見せる。
 */
export const TLD_RECOMMENDED_SECTION = '目的に合うおすすめ'
export const TLD_OTHERS_SECTION = 'ほかに取得できる末尾'
export const TLD_UNAVAILABLE_SECTION = 'いま選べない末尾'
/**
 * 一覧の各セルは末尾だけを出すので、名前と末尾をつないだ「結局どうなるのか」は
 * この1行が引き受ける。下の一覧から選んだ人は、ここでしか結果を確認できない。
 */
export const TLD_CHOSEN_NAME_LABEL = 'いま選んでいるドメイン'
export const TLD_SORT_LABEL = '並び替え'
export const TLD_SELECT_ACTION = '選ぶ'
export const TLD_SELECTED_LABEL = '選択中'
/**
 * 一覧の下に置く1行。
 *
 * 記号の対応表にはしない — セルは「選ぶ」か、選べない理由（「すでに使われて
 * います」など）を言葉でそのまま出しているので、記号を引き直す必要がない。
 * ここで言うべきなのは「押せないセルには理由が書いてある」ことだけ。
 */
export const TLD_LEGEND_NOTE = '「選ぶ」と出ている末尾が、いま取得できるものです。'
export const TLD_PRICE_NOTE = '料金は税込・1年あたり。「2年目以降 毎年」は、取ったあと毎年かかります。'

/** ステップ 4: 契約内容の確認 */
export const CONFIRM_HEADING = '内容の確認'
export const CONFIRM_LEDE = 'この内容で取得します。直すところは「変更」から。'
export const CONFIRM_CHANGE_ACTION = '変更'
export const CONFIRM_TO_PAYMENT_ACTION = 'お支払いに進む'
export const CONFIRM_SETTINGS_SUMMARY = '契約期間・自動更新を変える'
/**
 * §6.2.6 が決めているのは「隠した項目の既定値」であって、この文の言い回しではない。
 * ただしネームサーバーだけは「設定しない」が事実（orderDefaults の nameserverMode:
 * 'none'）なので、自動で用意する側に混ぜて書いてはならない。
 */
export const CONFIRM_HIDDEN_SETTINGS_NOTE =
  '認証コードと連絡先は自動で用意します。どこにつなぐかは設定せずに取得し、このあとの「つなぐ」で決めます。'
export const CONFIRM_INVALID_ERROR =
  '自動で入る設定に問題がありました。お手数ですが通常モードの申込フォームからお進みください。'

/**
 * 請求額は §6.2.5 の参照ペア（初年度／2年目以降）と同じ表に並べない。
 * 同じ金額が 2 行に並ぶと、どちらが請求額なのか読み手が確かめ直すことになる。
 */
export function confirmChargedLabel(years: number): string {
  return `今回のお支払い（${years}年分）`
}
/**
 * ⚠️ 自動更新 ON は「これ以上請求されない」ではない。金額を書かない ON 表示は
 * 支払い画面の「これで確定」と並ぶと二度と請求されないと読めてしまう。
 */
export function autoRenewOnSummary(renewalYen: string): string {
  return `ON（毎年 ${renewalYen} で自動更新）`
}
export const AUTO_RENEW_OFF_SUMMARY = 'OFF（自動では更新されません）'

/** ステップ 5: 支払い */
export const PAYMENT_HEADING = 'お支払い'
export const PAYMENT_LEDE = 'この操作でお支払いが確定します。'
export const PAYMENT_ACTION = '支払う（疑似決済）'
export const PAYMENT_IN_PROGRESS = '処理中…'

/**
 * 支払い画面の請求額の帯に付ける名前。
 * ⚠️ 確認画面の帯（confirmChargedLabel）と同じ形にそろえる — 2 画面で同じ金額を
 * 別の言い方で出すと、読み手はどちらが本当の請求額かを確かめ直すことになる。
 * この画面に出してよい合計は「いま請求される額」だけ（3年間の合計などは出さない）。
 */
export const paymentChargedLabel = confirmChargedLabel
/** 内訳は 1 年あたりの単価であって合計ではない、と見出しで言い切る。 */
export const PAYMENT_BREAKDOWN_HEADING = '1年あたりの料金'
export const PAYMENT_NEXT_YEARS_TERM = '来年以降'
/** ⚠️ 継続課金への同意はこの画面でしか取れない。金額と止め方を必ず添える。 */
export function autoRenewOnNote(renewalYen: string): string {
  return `自動更新はONです。毎年 ${renewalYen} を自動でお支払いします（マイページでいつでもOFFにできます）。`
}
export const AUTO_RENEW_OFF_NOTE =
  '自動更新はOFFです。使い続けるときは、マイページから手動で更新してください。'

/** ステップ 6: easyDNS 設定 */
export const DNS_HEADING = 'ドメインをつなぐ'
/** 取得直後のバナー。ドメイン名のあとに続けて読ませる（＝残りは1つだけ、と伝える）。 */
export const DNS_ACQUIRED_NOTE = 'はあなたのものになりました。あとは、つなぎ先を選ぶだけです。'
export const DNS_PLAN_QUESTION = 'このドメインを何に使いますか？'
/** ⚠️ 聞いているのは「どこにつなぐか」。レコードやネームサーバーの話にしない。 */
export const DNS_SERVICE_QUESTION = 'サイトやメールは、どこにありますか？'
/** 使いみちは目的（ステップ1）から自動で決める。この行はその答えの読み上げ。 */
export const DNS_PLAN_ANSWER_PREFIX = '使いみち'
export const DNS_PLAN_CHANGE_ACTION = '使いみちを変える'
export const DNS_LATER_HINT = 'まだ決まっていなくても大丈夫です。あとからいつでも設定できます。'
export const DNS_DETAILS_SUMMARY = '詳細を見る（書き込まれる設定）'
/** §1.4: 用語は消さず、平易な言い換えを先に出したうえで、開いた人にだけ見せる。 */
export const DNS_DETAILS_NOTE =
  '専門用語で「DNSレコード」と呼ばれる、名前と場所の対応表です。意味が分からなくても、そのまま進んで問題ありません。'
export const DNS_APPLY_ACTION = 'この設定でつなぐ'
/**
 * ステップ 6: 「この設定でつなぐ」の直前に必ず出す「何が起きるか」。
 *
 * ⚠️ サービスごとの固定文を持ってはならない。実際に保存するレコードから
 * 組み立てる（レシピが変われば文も変わる）。表を折りたたみの中だけに置くと、
 * 入力欄を持たないサービス（Vercel など）では画面が何も変わらないまま
 * 確定させることになり、初心者は自分が何を承認したのか分からない。
 */
export const DNS_OUTCOME_HEADING = 'この設定でつなぐと、こうなります'
/** 「A と B を Vercel に向けます。」— hosts は保存するレコードの名前から作る。 */
export function dnsOutcomeWebSentence(hosts: string, serviceName: string): string {
  return `${hosts} を ${serviceName} に向けます。`
}
/** メールのレコード（MX）を書くときの言い換え。「向ける」ではなく「届ける」。 */
export function dnsOutcomeMailSentence(domainName: string, serviceName: string): string {
  return `${domainName} 宛のメールを ${serviceName} に届けます。`
}
/** 取得直後なので、ここに挙げた以外に影響を受けるものは無い。 */
export const DNS_OUTCOME_NOTHING_ELSE = 'ほかに変わるものはありません。'
/** 貼り付けパーサで読み取った設定はレシピ名を持たない。 */
export const DNS_OUTCOME_PASTED_SERVICE = '案内文に書かれていた先'
export const DNS_SKIP_ACTION = 'あとで設定する'
export const DNS_MANUAL_LINK = '自分で細かく設定する'
export const DNS_PLAN_REQUIRED_ERROR = '使いみちを1つ選んでください。'
export const DNS_SERVICE_REQUIRED_ERROR = 'つなぎ先を1つ選んでください。'
export const DNS_INPUT_REQUIRED_ERROR = '必要な項目を入力してください。'
export const DNS_SAVE_FAILED_MESSAGE = '設定を保存できませんでした。時間をおいて再度お試しください。'
export const DNS_NS_GUIDE_NOTE_HEADING = 'このサービスは、つなぎ方が少し違います'

/**
 * ステップ 6 (ns-guide): レコードではなくネームサーバーごと預けるサービス。
 * ⚠️ ここでレコードを保存してはならない（全置換で空にする保存になる）。
 * NS変更の警告文そのものは mypageMessages.ts の NS_CHANGE_WARNING が正。
 * 用語（ネームサーバー）は平易な説明のうしろに括弧で添えるだけにする（§1.4）。
 */
export const DNS_NS_GUIDE_DESCRIPTION =
  'このサービスには、ドメインの管理そのものを預けます。この画面では設定せず、次の画面で手続きしてください（専門用語で「ネームサーバーの変更」）。'
export const DNS_NS_GUIDE_ACTION = 'ネームサーバーの変更に進む'
/**
 * ステップ 6 (ns-guide): NS_CHANGE_WARNING は通常モードと共有の正文なので
 * 書き換えない（dnsFlow / mypageFlow が逐語で検証している）。取得直後の
 * ドメインには止まるものが何も無い、という事実をこの一文で必ず添える。
 * これが無いと、警告だけを読んだ人が「壊れる操作だ」と受け取って離脱する。
 */
export const DNS_NS_GUIDE_FRESH_NOTE =
  '取得したばかりのこのドメインには、まだ設定もメールもありません。いま切り替えても、止まるものはありません。'
/** ns-guide を一方通行の出口にしないための逃げ道の説明。 */
export const DNS_NS_GUIDE_LATER_NOTE =
  'いま手続きしなくても大丈夫です。マイページの「DNS設定」から、いつでも同じ手続きに戻れます。'

/** ステップ 6 (§6.3.3c): 一覧にないサービスのための貼り付けパーサ導線。 */
export const DNS_PASTE_OPTION_LABEL = '一覧にないサービスを使っている'
export const DNS_PASTE_OPTION_DESCRIPTION = 'サービスから届いた案内文を貼り付けると、必要な設定を読み取ります。'
export const DNS_PASTE_OPEN_ACTION = '案内文を貼り付ける'
export const DNS_PASTE_REQUIRED_ERROR = '案内文から設定を読み取ってください。'
export const DNS_PASTE_ADOPTED_NOTE = '案内文から読み取った設定です。この内容で保存します。'

/**
 * ステップ 6: 「つなぐ先がまだ無い」人の経路。
 *
 * ⚠️ ここが無いと、ドメインだけ買った人はどの選択肢にも当てはまらず袋小路になる
 * （「あとで設定する」は逃げ道であって、何をすればいいかの答えではない）。
 * 用意するもの → 例 → 順番 → いま決めなくていい、の4点だけを言う。
 */
export const DNS_NO_TARGET_OPTION_LABEL = 'サイトやメールは、まだ用意していない'
export const DNS_NO_TARGET_OPTION_DESCRIPTION = '何を用意すればいいかをご案内します。'
export const DNS_NO_TARGET_HEADING = 'つなぐ先を用意するところから始めましょう'
export const DNS_NO_TARGET_BODY =
  'サイトを置く場所か、メールを預ける会社を1つ決めると、そこにつなげられるようになります。'
export const DNS_NO_TARGET_WEB_EXAMPLES =
  'サイト：Wix、ペライチ、WordPress.com、さくらのレンタルサーバ、エックスサーバー、Vercel、Netlify など'
export const DNS_NO_TARGET_MAIL_EXAMPLES = 'メール：Google Workspace、Microsoft 365 など'
export const DNS_NO_TARGET_SAFE_NOTE =
  'いま決めなくても大丈夫です。取得したドメインは有効期限まであなたのもので、つなぎ先はあとから何度でも変えられます。'
export const DNS_NO_TARGET_SKIP_HINT = '用意ができたら、この続きから設定できます。'
/** 使いみちが未定の人にも同じ答えを渡すための、折りたたみの見出し。 */
export const DNS_NO_TARGET_DISCLOSURE = 'サイトやメールを、まだ用意していないときは'

/** つなぐ先を用意する手順。ステップ6の案内と完了画面（未設定時）で共有する。 */
export const CONNECT_TARGET_STEPS: readonly string[] = [
  '使いたいサービスに登録する（無料で試せるものもあります）',
  'そのサービスから「独自ドメインの設定方法」の案内が届く',
  'マイページの「DNS設定」に戻って、そのサービスを選ぶか、届いた案内文をそのまま貼り付ける',
]

/**
 * ステップ 6b (§6.3.3d): 保存したあとの「つながったか確認する」フェーズ。
 * ⚠️ 保存直後は必ず「反映待ち」になる。これは正常系なので、赤いエラーとして
 * 見せてはならない。4状態の文言は dnsCheckStatus.ts の DNS_CHECK_LABELS が正。
 */
export const DNS_SAVED_MESSAGE = 'つなぐ設定を保存しました'
/** 初心者がこの瞬間に抱く唯一の疑問に、先回りで答える。 */
export const DNS_SAVED_WAIT_HEADING = 'これで見えるようになりますか？'
export const DNS_SAVED_WAIT_BODY =
  'ふつうは数分、長いときは48時間ほどかかります。すぐに表示されなくても失敗ではありません。下の「すべて確認」で、いまの状態を調べられます。'
export const DNS_CHECK_DONE_ACTION = '完了'
/**
 * ⚠️ 「反映待ち」も「未公開」も正常系。確認パネルは押されるまで問い合わせない
 * うえ、取得直後のドメインはネームサーバー未設定（＝未公開）で着地する
 * (§6.2.6)。待ったまま完了してよいことを明示しないと、初心者はこの画面から
 * 進めなくなる。⚠️ ここで状態名を引用する以上、DNS_CHECK_LABELS を変えたら
 * この文も合わせること（画面に出ていない状態名を引用しない）。
 */
export const DNS_CHECK_DONE_NOTE =
  '「反映待ち」や「未公開」のままでも、このまま完了して大丈夫です。状態はマイページからいつでも確認できます。'

/** ステップ 7: 完了 */
/** ⚠️ 見出しは状態ごとに変える。つなぐ設定をしていない人に「設定が完了」と言わない。 */
export const DONE_HEADING_CONNECTED = 'つなぐ設定まで終わりました'
export const DONE_HEADING_SKIPPED = 'ドメインを取得しました'
export const DONE_TO_MYPAGE_ACTION = 'マイページへ移動する'
export const DONE_DNS_SKIPPED_NOTE =
  'つなぐ設定はまだしていません。ドメインはあなたのものなので、あとからいつでも設定できます。'
export const DONE_NEXT_HEADING = 'このあとすること'
/** 貼り付けパーサで設定した人の「つないだ先」（レシピ名を持たない）。 */
export const DONE_TARGET_PASTED = '案内文から読み取った設定'
/** つなぐ設定をしていない人の「使いみち」。'あとで設定する' は用途の答えではない。 */
export const DONE_PLAN_UNSET = 'まだ決めていません'
/** 見出し下の 1 行。⚠️ つないでいない人に「準備ができました」と言わない。 */
export const DONE_SUBLINE_CONNECTED = 'の準備ができました。'
export const DONE_SUBLINE_SKIPPED = 'はあなたのものになりました。'
/** 通常モードへの卒業導線（§1.4: 用語は残したうえで平易な言い換えを先に出す）。 */
export const DONE_MANUAL_LINK = '自分で細かく設定する（DNS設定）'
/**
 * つないだ人の 2 番目のボタン。この画面は「確認できます」と約束しているので、
 * その約束と同じ言葉を名乗る（＝「自分で細かく設定する」ではない）。
 * つないでいない人には確認するものが無いので、そちらは DONE_MANUAL_LINK のまま。
 */
export const DONE_CHECK_ACTION = 'つながったか確認する'
export const DONE_VISIBLE_HEADING = 'いつ見えるようになりますか？'
export const DONE_PROPAGATION_NOTE =
  '設定が世界中に伝わるまで、ふつうは数分、長いときは48時間ほどかかります。すぐに表示されなくても失敗ではありません。'
export const DONE_CHECK_HEADING = '確かめかた'
export const DONE_CHECK_NOTE =
  'ブラウザのアドレス欄に、上のドメインをそのまま入力して開いてみてください。まだのときは、少し時間をおいてもう一度どうぞ。'
/** ⚠️ §6.2.2: メールは「レコードを書けた」までしか当サービスでは確認できない。 */
export const DONE_MAIL_NOTE = 'メールは、メールサービス側の準備が終わってから使えるようになります。'

/** 復帰まわり */
export const RESUME_BANNER = '前回の続きから進められます。'

/**
 * `/easy` の入口で、下書きが残っているときに出す選択（issue #91）。
 *
 * ⚠️ 見出しで「途中まで進んでいる」という事実を先に言い切ること。以前は無言で
 * 途中のステップへ飛ばしていたため、初見の人には「なぜ 2/6 から始まるのか」も
 * 「なぜ知らない文言が入っているのか」も説明されないままだった。
 */
export const ENTRY_HEADING = '前回の続きがあります'
export const ENTRY_LEDE = '途中まで入力した内容が残っています。続きから進むか、最初からやり直すかを選んでください。'
export const ENTRY_SAVED_HEADING = '保存されている内容'
export const ENTRY_SAVED_PURPOSE_LABEL = '用途'
export const ENTRY_SAVED_NAME_LABEL = 'ドメイン名'
export const ENTRY_RESUME_ACTION = '続きから進む'
export const ENTRY_RESTART_ACTION = '入力内容を消して最初からやり直す'

/*
 * かつてここに、かんたんモードのヘッダーへ常時出す現在地バッジ＋
 * 「通常モードに戻る」出口（EASY_MODE_HEADER_BADGE / EASY_MODE_EXIT_ACTION、
 * issue #91）があったが、バーに通常/かんたんの文字が並ぶこと自体が余計だ、
 * という利用者の指摘で削除した（2026-08-28）。復活させないこと。通常モードへは
 * ブランドリンク（トップ = clearEasyDrafts のやり直し起点）とフッターから戻れる。
 */

/**
 * ログインを挟むときの案内（入力は消えないことを明示する）。
 *
 * ステップ3では、この一文のすぐ下に本物のログインフォームが出る。「ログインが
 * 必要です」とだけ言って別画面へ飛ばすと、初心者はウィザードから落ちたと感じる
 * ため、案内も「ここで済ませられる」と読める言い回しにしてある。
 */
export const LOGIN_REQUIRED_NOTICE =
  'ここから先はログインが必要です。入力した内容は保存されているので、そのまま続きに進めます。'

/** ステップ3に埋め込むログインカードの見出しと、アカウントが無い人への導線。 */
export const LOGIN_CARD_HEADING = 'ログインして続ける'
export const LOGIN_CARD_SIGNUP_PROMPT = 'アカウントをお持ちでない方は'
export const LOGIN_CARD_SIGNUP_ACTION = '会員登録'
