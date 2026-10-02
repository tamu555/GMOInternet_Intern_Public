/**
 * DNS設定画面の固定文言。§6.3.3 由来の仕様文言が中心で、勝手に「改善」しない。
 * 4状態（未設定/反映待ち/確認できた/値が違う）の文言は dnsCheckStatus.ts の
 * DNS_CHECK_LABELS が正で、ここには持たない。
 */

/* ------------------------------------------------------------------------
 * §6.3.3(a) の「最初の1問」。
 *
 * 仕様が固定しているのは “問いと2つの答え”（＝どちらの階層の話かを最初に
 * 確定させること）であって、それを画面の一番上に置くことではない。
 * 初心者には専門用語の問いより先に「手元の案内を開く」という動作を渡し、
 * 仕様の問い自体はカード末尾に原文のまま残す（DNS_MODE_QUESTION_NOTE）。
 * ---------------------------------------------------------------------- */

/** §6.3.3(a) 最初の1問 — この1問で2階層のどちらの話かを確定させる。 */
export const DNS_MODE_QUESTION =
  '契約したサービスから「ネームサーバー（ns1.〜 のような文字列）」を渡されましたか？'

/** §6.3.3(a) 2階層（①どのDNSに任せるか ②そこに何を書くか）の補足説明。 */
export const DNS_MODE_HINT =
  'DNSの設定には「①どのDNSに任せるか（ネームサーバー）」と「②そこに何を書くか（レコード）」の2段階があります。いま設定するのは、そのうちの片方だけです。'

/**
 * §6.3.3(a) の2つの答え。⚠️ これは「くわしく知りたい方へ（専門用語での説明）」
 * の中の DNS_MODE_QUESTION 専用のラベルで、選択肢カードには出さない
 * （2026-08-28 — 経緯は DnsModeChoiceStep.tsx の冒頭）。問いから切り離すと
 * 「はい、渡された」が何への「はい」なのか読めなくなる。
 */
export const DNS_MODE_NS_LABEL = 'はい、渡された'
export const DNS_MODE_NS_DESCRIPTION =
  'ネームサーバーの差し替え（委任先の変更）を行います。以降のレコード設定は不要です。'
export const DNS_MODE_RECORDS_LABEL = 'いいえ／IPアドレスをもらった'
export const DNS_MODE_RECORDS_DESCRIPTION =
  '当サービスのDNSにレコード（A・CNAME・MXなど）を設定します。'

/* ---- 分岐画面の導入（仕様の問いより前に読ませる、こちら側の文言） ---- */

/**
 * 使いみち（DnsGoalStep）を選んだ次の画面。入口ではないので「案内を開く」から
 * 始めてよい — 案内が無い人は、ここへ来る前に DnsPrepareStep へ分かれている。
 */
export const DNS_INTRO_TITLE = '使うサービスから届いた案内を、手元に開いてください'
export const DNS_INTRO_LEAD =
  '案内に書かれている文字を、この画面に写すだけで設定できます。意味の分からない文字列でも、そのままコピーすれば大丈夫です。'
export const DNS_INTRO_DURATION =
  '入力は3分ほどで終わります（設定が世界中に行き渡るのを待つ時間は別です）'

/** 2択の問い直し。用語ではなく「案内に何が書いてあるか」だけを尋ねる。 */
export const DNS_MODE_EVIDENCE_QUESTION = '案内に書いてあるのは、どちらですか？'

export const DNS_MODE_NS_EVIDENCE = '「ns1.〜」のような文字列が2つ書いてある'
export const DNS_MODE_NS_EXAMPLE = 'ns1.example.com / ns2.example.com'
export const DNS_MODE_NS_OUTCOME = 'このあと、その2つを入力して保存すれば終わりです。'

export const DNS_MODE_RECORDS_EVIDENCE = '数字のIPアドレスや、案内先のホスト名が書いてある'
export const DNS_MODE_RECORDS_EXAMPLE = '203.0.113.10 / cname.vercel-dns.com'
export const DNS_MODE_RECORDS_OUTCOME =
  'このあと、テンプレートを選ぶか案内文を貼り付けるだけで入力できます。'

/** 「分からない」を脚注ではなく3つ目の選択肢として置くためのラベル。 */
export const DNS_MODE_UNSURE_LABEL = '案内が見当たらない・どちらか分からない'
export const DNS_MODE_UNSURE_SUMMARY = '押すと、案内のどこを見ればよいかを表示します。'

/**
 * 迷ったときの既定は必ずレコード側にする。ネームサーバー変更は §6.3.3(e) の
 * とおりメールまで止まる操作で、確信のない人に勧めてはいけない。
 */
export const DNS_MODE_UNSURE_FALLBACK_LABEL = '分からないまま、レコードの設定から始める'
export const DNS_MODE_UNSURE_FALLBACK_NOTE =
  'レコードの設定は、あとから何度でもやり直せます。もう一方のネームサーバー変更は、メールが止まることがあるので、確信があるときだけ選んでください。'

/** カード末尾に仕様の問いを原文のまま残すための前置き。 */
export const DNS_MODE_QUESTION_NOTE = 'この画面で答えているのは、次の1問です。'

/** 選択後に初めて出す「いま2段階のどちらを触っているか」の見出し。 */
export const DNS_MODE_NOW_NS = 'いま設定しているのは ①どのDNSに任せるか（ネームサーバー）です'
export const DNS_MODE_NOW_RECORDS = 'いま設定しているのは ②そこに何を書くか（レコード）です'
export const DNS_MODE_RESELECT_LABEL = 'つなぎ方を選び直す'

/* ---- NS変更モード ---- */

/** 用語の言い換えより先に「何をすればよいか」を渡す。 */
export const NS_MODE_LEAD =
  '契約したサービスから渡された「ns1.〜」のような文字列を、下の欄に上から順に貼り付けてください。入力するのはこの2つだけです。'
export const NS_MODE_TECHNICAL_NOTE =
  'このドメインをどのDNSに任せるかの指定（レジストリの domain:update）を差し替えます。'

/** 保存後: すぐ見えなくても失敗ではないことを、確認しに行く前に伝える。 */
export const NS_MODE_DONE_NEXT =
  '反映されるまで通常数分、長いときは48時間ほどかかります。この画面を閉じても設定は残ります。'

/** NS変更モード: 変更後はこの画面のレコードが配信されなくなることの説明。 */
export const NS_MODE_RECORDS_DISABLED_NOTE =
  'ネームサーバーを他社に変更すると、この画面で設定したレコードは配信されなくなります。'

/** レコード未保存時の案内（確認パネルの「未設定」状態と対で表示）。 */
export const RECORDS_NOT_SAVED_NOTICE = 'つなぎ先は、まだ1件も保存されていません。'

export const RECORDS_SAVED_NOTICE =
  'つなぎ先を保存しました。下の「確認する」で、実際につながったかを確かめられます。'

/* ------------------------------------------------------------------------
 * 手順ガイド（ステップ形式）の文言。
 * §6.3.3 の仕組みは保ったまま、初心者が「次に何をすればよいか」だけを
 * 読めば進めるように、各ステップの問いかけと補足をここに集約する。
 * ---------------------------------------------------------------------- */

/** STEP1 の問いかけ。3つの入口のどれを使うかだけを決めさせる。 */
export const METHOD_STEP_QUESTION = '渡された案内を、どうやって入力しますか？'
export const METHOD_STEP_HINT =
  '使っているサービスが分かっていれば、テンプレートを選ぶのがいちばん確実です。入力するのは「どこへ案内するか」の値だけです。'

export const METHOD_TEMPLATE_LABEL = 'テンプレートから選ぶ'
export const METHOD_TEMPLATE_DESCRIPTION =
  'Vercel・Google Workspace など、使うサービスを選ぶだけで必要な設定を用意します。'
export const METHOD_PASTE_LABEL = '案内文を貼り付ける'
export const METHOD_PASTE_DESCRIPTION =
  'サービスから届いた設定案内をコピーして貼り付けると、内容を読み取って入力欄に入れます。'
export const METHOD_MANUAL_LABEL = '自分で入力する'
export const METHOD_MANUAL_DESCRIPTION = '渡された内容を1件ずつ自分で入力します。'

/** STEP2。入力欄の並びより先に「今なにをする時間か」を読ませる。 */
export const EDIT_STEP_TITLE = '設定の内容を入力する'
export const EDIT_STEP_HINT =
  'サービスから渡された値を、そのままコピーして貼り付けてください。入力に問題があるとその場でお知らせします。'

/** STEP3。全置換であることは保存前に必ず伝える。 */
export const CONFIRM_STEP_TITLE = 'この内容で保存します'
export const CONFIRM_STEP_HINT =
  '保存すると、このドメインの設定は下の内容にまるごと置き換わります。間違いがないか確認してください。'
export const CONFIRM_EMPTY_WARNING =
  '保存する内容が1件もありません。このまま保存すると、いまの設定はすべて削除されます。'

/** STEP4。保存しただけでは終わりではないことを明示する。 */
export const DONE_STEP_TITLE_SAVED = '設定を保存しました'
export const DONE_STEP_TITLE_CURRENT = 'いまのつながり方'
export const DONE_NEXT_TITLE = '次にやること'
export const DONE_NEXT_STEPS: readonly string[] = [
  '下の「つながったか確認する」で「すべて確認」を押して、設定が行き渡ったか調べます。',
  '「反映待ち」と出ても失敗ではありません。行き渡るまで通常数分、長いときは48時間ほどかかります。',
  '「確認できた」になったら、ブラウザで実際にアクセスして表示を確認します。',
]

/** 入力エラーがあるまま先へ進もうとしたときの案内。 */
export const EDIT_HAS_ERRORS_NOTICE =
  '入力に誤りがあります。赤い文字の説明のとおりに直してから、もう一度お進みください。'
export const EDIT_NO_RECORDS_NOTICE = '入力する内容がまだありません。上のボタンから追加してください。'

/** 「値が違う」ときの原因と直し方（§6.3.3d は状態名までしか定めていない）。 */
export const CHECK_MISMATCH_HELP =
  '行き渡る途中で一時的にこうなることもあります。10分ほど待ってもう一度確認しても直らないときは、サービスの案内をもう一度コピーして値を入れ直してください。'

/** 3つ目の選択肢（分からない）を開いたときの本文。見分け方だけを渡す。 */
export const DNS_MODE_UNSURE_HINT =
  '契約したサービスから届いた案内を見てください。「ns1.〜」のような文字列が2つ書いてあれば「はい」、203.0.113.10 のような数字や ◯◯.example.com のような案内先が書いてあれば「いいえ」です。'
