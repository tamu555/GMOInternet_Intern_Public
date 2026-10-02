/**
 * 「ドメインをつなぐ」入口の文言。
 *
 * dnsMessages.ts が §6.3.3 由来の仕様文言（問い・4状態・警告）を持つのに対し、
 * こちらは仕様が固定していない範囲 — 目的から入る導線、前提の説明、専門用語を
 * 出さない言い換え — を集めている。
 *
 * ⚠️ 方針: 既定の読み筋に DNS / ネームサーバー / レコード / リゾルバ / A / CNAME
 * / MX を出さない。用語は消さず「くわしく知りたい方へ」の開閉部に移す（§1.4 の
 * 「消し去るのではなく併記する」を、初心者の読む順に合わせた形）。
 */

/* ---- 画面の名前 ---- */

/** 画面の目的そのものを見出しにする（「DNS設定」は用語であって目的ではない）。 */
export const CONNECT_PAGE_TITLE = 'ドメインをつなぐ'

/* ------------------------------------------------------------------------
 * 仕組みの説明。1度だけ、絵つきで、短く。
 * ここを「DNSの授業」にしないこと — 知りたいのは「なぜ今は何も出ないのか」
 * と「自分は何を出せば終わるのか」の2点だけ。
 * ---------------------------------------------------------------------- */

export const CONNECT_MODEL_TITLE = 'いまは、名前と中身がつながっていません'

/** 図と同じ意味を必ず文字でも持たせる（図は aria-hidden の装飾）。 */
export const CONNECT_MODEL_DIAGRAM_CAPTION =
  'ドメイン名 →（この画面でつなぐ）→ ホームページやメールのある場所'

export function connectModelBody(domainName: string): string {
  return `${domainName} は、インターネット上の住所です。ホームページの中身やメールは、それとは別の会社のコンピュータに置かれています。いまはその2つが結びついていないので、${domainName} と打っても何も出てきません。この画面ですることは、住所と置き場所を結びつける「転送届」を1回出すことだけです。`
}

/* ---- 使いみちの選択（最初の1画面） ---- */

export const GOAL_STEP_TITLE = 'このドメインを、何に使いますか？'
export const GOAL_STEP_LEAD = '選んだ使いみちに合わせて、必要な手順だけをご案内します。'

export const GOAL_WEB_LABEL = 'ホームページを見せたい'
export const GOAL_WEB_DESCRIPTION =
  'このドメイン名を打った人に、用意したホームページが表示されるようにします。'

export const GOAL_MAIL_LABEL = 'メールで使いたい'
export const GOAL_MAIL_DESCRIPTION =
  'このドメイン名を使ったメールアドレスで、メールを受け取れるようにします。'

/** 3つ目の入口。ドメインしか持っていない人には、いま行ける先が他にない。 */
export const GOAL_NONE_LABEL = 'まだ何も用意していない／何をすればいいか分からない'
export const GOAL_NONE_DESCRIPTION =
  'ドメインだけでは、まだ何も表示されません。先に何を用意すればよいかをご案内します。'

export const GOAL_RESELECT_LABEL = '使いみちを選び直す'
export const GOAL_ECHO_WEB = '使いみち: ホームページを見せたい'
export const GOAL_ECHO_MAIL = '使いみち: メールで使いたい'

/* ------------------------------------------------------------------------
 * 「まだ何も用意していない」経路。
 *
 * ⚠️ この画面だけは、設定させることが目的ではない。ドメイン単体では何も
 * できないという前提を伝え、次に登録すべきサービスの名前を渡して、安心して
 * 画面を離れてもらうことが目的。行き止まりを作らない。
 * ---------------------------------------------------------------------- */

export const PREPARE_TITLE = '先に、中身を置く場所を用意します'
export const PREPARE_LEAD =
  'ドメインは住所です。住所だけでは、まだ見せるものがありません。ホームページなら中身を置くサービス、メールならメールのサービスを、先に1つ決めてください。'

export type PrepareExample = { readonly name: string; readonly note: string }

export const PREPARE_WEB_TITLE = 'ホームページを見せたいとき'
export const PREPARE_WEB_BODY = '文章や写真を置いて公開できるサービスに、1つ登録します。'
export const PREPARE_WEB_EXAMPLES: readonly PrepareExample[] = [
  {
    name: 'Wix / STUDIO / ペライチ',
    note: '画面を見ながらページを作れます。作るところから公開まで1つで済みます。',
  },
  {
    name: 'Vercel / Netlify / GitHub Pages',
    note: '作ったサイトのファイルを置いて公開します。小さなサイトなら無料で使える範囲があります。',
  },
  {
    name: 'エックスサーバー / さくらのレンタルサーバ',
    note: '月額のレンタルサーバーです。WordPress でブログやお店のページを作りたいときはこちら。',
  },
]

export const PREPARE_MAIL_TITLE = 'メールで使いたいとき'
export const PREPARE_MAIL_BODY = 'このドメインのメールを扱えるサービスに、1つ登録します。'
export const PREPARE_MAIL_EXAMPLES: readonly PrepareExample[] = [
  { name: 'Google Workspace', note: 'ふだんの Gmail の画面で、このドメインのメールを送受信できます。' },
  { name: 'Microsoft 365', note: 'Outlook の画面で、このドメインのメールを送受信できます。' },
  {
    name: 'レンタルサーバーのメール機能',
    note: 'エックスサーバーやさくらのレンタルサーバは、サーバーの契約にメールが付いてきます。',
  },
]

export const PREPARE_SEQUENCE_TITLE = 'このあとの流れ'
export const PREPARE_SEQUENCE: readonly string[] = [
  '上のようなサービスを1つ選んで、登録します（この画面での操作はありません）。',
  'そのサービスの設定画面で「独自ドメインを使う」を選び、このドメイン名を伝えます。',
  '「次の内容を設定してください」という案内が表示されます。それを持って、この画面に戻ってきてください。',
]

export const PREPARE_SAFE_TITLE = 'いま設定しなくても大丈夫です'
export const PREPARE_SAFE_BODY =
  'このまま何も設定せずに閉じても、ドメインはあなたのものとして登録されたままです。なくなったり、他の人に取られたりすることはありません。準備ができてから、いつでもこの画面を開き直せます。'

export const PREPARE_BACK_TO_DETAIL_LABEL = 'ドメインの画面に戻る'
export const PREPARE_HAS_GUIDE_LABEL = '案内はもう手元にある — 使いみちを選んで始める'

/* ---- 選んだあとの帯（いま自分が何をしているか） ---- */

export const MODE_BADGE_NS = 'サービスに管理をまかせる'
export const MODE_BADGE_RECORDS = 'つなぎ先をここで設定する'

export const MODE_NOW_NS_PLAIN = 'いましているのは、このドメインの案内役をそのサービスに引き渡すことです'
export const MODE_NOW_NS_BODY =
  '渡された文字列を保存すると、以降このドメインの案内はそのサービスが受け持ちます。ホームページもメールも、設定はそちらの画面で行うことになります。'

export const MODE_NOW_RECORDS_PLAIN = 'いましているのは、このドメインのつなぎ先を書き込むことです'
export const MODE_NOW_RECORDS_BODY =
  '案内役はこのサービスのまま、「どこへ案内するか」だけを登録します。あとから何度でも直せます。'

/** 専門用語をまとめて置く開閉部の見出し。既定では閉じている。 */
export const JARGON_DISCLOSURE_LABEL = 'くわしく知りたい方へ（専門用語での説明）'

/* ---- 確認パネル（「つながりましたか？」に答える画面） ---- */

export const CHECK_PANEL_TITLE = 'つながったか確認する'

/**
 * ⚠️ 「インターネット側から実際に見えるようになったか」とは書けない。この確認が
 * 引いているのは当サービスのDNS（§6.3.2 レベル2 の自前ミニリゾルバ）であって、
 * 世界中のDNSではない。書けないことを書くと、マイページの「まだインターネットに
 * 公開されていません」と真正面から矛盾する。
 */
export const CHECK_PANEL_DESCRIPTION =
  '保存した内容が、当サービスのDNSに正しく登録されているかを調べます。'
export const CHECK_EXPECTED_LABEL = '保存した内容'
export const CHECK_ACTUAL_LABEL = 'いま実際に返ってくる内容'

/* ---- 委任状態の注記（この確認が答えられない範囲を先に言う） ---- */

/**
 * ネームサーバー未設定（§3.5 `inactive`）。マイページと同じ事実を、この画面の
 * 文脈（＝いま保存したものはどうなるのか）で言い直す。
 */
export const CHECK_NOT_PUBLISHED_NOTICE =
  'このドメインはまだインターネットに公開されていません（取得した直後はこの状態です）。ここで保存した内容は、ネームサーバーを設定するまで誰にも届きません。'

/** 行き止まりにしない — 未公開の注記からは必ずNS変更へ進めるようにする。 */
export const CHECK_NOT_PUBLISHED_ACTION = 'ネームサーバーを設定する'

/**
 * ネームサーバーが外部に向いている場合。委任先が答える以上、当サービスに
 * 保存したレコードは使われない。✓ が出ていても「世界から見えている内容」では
 * ないことを、ここで言い切る。
 */
export const CHECK_EXTERNAL_DELEGATION_NOTICE =
  'このドメインは外部のネームサーバーに任されているため、ここで保存した内容は公開には使われません。実際に見えている内容は、任せた先のサービスの設定で決まります。'
