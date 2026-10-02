/**
 * ステップ7: 完了（/easy/done）。
 *
 * ここで一時保存を破棄する（仕様どおり「契約または設定が完了したら削除」）。
 * 破棄はマウント時ではなくボタン押下時に行う: 先に消すと、リロードした瞬間に
 * ガードが「注文が無い」と判断してウィザードの先頭へ戻してしまう。
 *
 * この画面が答えるべき問いは 1 つ:「これで、私のサイトは見えるようになったの？」
 *   - つないだ人 → いつ見えるか・待つのは正常・どう確かめるか
 *   - つないでいない人（「あとで設定する」で抜けた人と、ns-guide の案内側へ
 *     出ていった人の両方）→ ドメインは自分のもの・次に何をするか
 * ⚠️ 見出しも状態で変える。つなぐ設定をしていない人に「設定が完了しました」と
 * 言うのは嘘で、初心者はそれを「もう見えるはず」と読む。この「していない人」の
 * 判定は `dnsPlan === 'later'` ではない（下の `connected` の ⚠️ を参照）。
 *
 * ⚠️ そのうえで、**つないだ人にも「これで公開できました」と言ってはならない**
 * （2026-08-28 にゴールを「ドメイン取得」から「サイト公開」へ置き直したときの
 * 決定）。サイトの中身の置き場所（サーバー・ホスティング）は当サービスでは
 * 用意できず、利用者が別のサービスで契約する。つなぐ設定を保存しても置き場所が
 * 無ければサイトは表示されないので、「⑥まで押した＝公開完了」は嘘になる。
 * そこで easyJourney.ts の 3 部品を、この人にとって済んでいるか／残っているかの
 * チェックリストとして出す。**②「サイトの置き場所」だけは当サービスから知る
 * 手段が無いので、済み／未を断定せず `unknown` のまま見せる** — この画面で
 * 一番大事な設計判断はここで、断定した瞬間にどちらかの人に嘘をつくことになる。
 */
import { Link, useNavigate } from 'react-router-dom'
import { Check, CircleCheck, CircleDashed, CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBanner } from '../../components/StatusBanner'
import { EASY_PASTE_SERVICE_ID, dnsPlanLabel, serviceById } from './easyDnsPlans'
import {
  EASY_DONE_CONNECTED_CONCLUSION,
  EASY_DONE_CONNECT_DONE_NOTE,
  EASY_DONE_CONNECT_TODO_NOTE,
  EASY_DONE_DOMAIN_NOTE,
  EASY_DONE_JOURNEY_HEADING,
  EASY_DONE_PENDING_CONCLUSION,
  EASY_DONE_PLACE_NOTE,
  EASY_DONE_TARGET_CHOSEN_LABEL,
  EASY_DONE_TARGET_CONNECTED_LABEL,
  EASY_JOURNEY_PARTS,
  EASY_JOURNEY_STATUS_LABEL,
  type EasyJourneyPart,
  type EasyJourneyPartStatus,
} from './easyJourney'
import {
  CONNECT_TARGET_STEPS,
  DONE_CHECK_ACTION,
  DONE_CHECK_HEADING,
  DONE_CHECK_NOTE,
  DONE_DNS_SKIPPED_NOTE,
  DONE_HEADING_CONNECTED,
  DONE_HEADING_SKIPPED,
  DONE_MAIL_NOTE,
  DONE_MANUAL_LINK,
  DONE_NEXT_HEADING,
  DONE_PLAN_UNSET,
  DONE_PROPAGATION_NOTE,
  DONE_SUBLINE_CONNECTED,
  DONE_SUBLINE_SKIPPED,
  DONE_TARGET_PASTED,
  DONE_TO_MYPAGE_ACTION,
  DONE_VISIBLE_HEADING,
} from './easyMessages'
import { useEasy } from './useEasy'
import { useEasyDoneGate } from './useEasyGate'

/**
 * チェックリストの 1 行。
 *
 * ⚠️ 状態をアイコンと色だけで伝えないこと。3 状態のうち 2 つ（`todo` と
 * `unknown`）は「まだ丸が付いていない」点で見た目が似ており、記号だけだと
 * 「未設定」と「当サービスには分からない」が同じものに見える。答えは
 * `EASY_JOURNEY_STATUS_LABEL` の**文字列そのもの**が持つ。
 */
function EasyJourneyRow({
  part,
  status,
  note,
}: {
  part: EasyJourneyPart
  status: EasyJourneyPartStatus
  note: string
}) {
  const Icon = status === 'done' ? Check : status === 'todo' ? CircleDashed : CircleHelp
  const accent = status === 'done' ? 'text-green-brand' : 'text-muted-foreground'

  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
      <Icon className={`mt-0.5 size-4 shrink-0 ${accent}`} aria-hidden="true" />
      <div className="min-w-[14rem] flex-1 space-y-0.5">
        <p className="text-sm font-medium">
          {part.title}
          {/* §1.4「用語は消さず併記」。つなぐ設定の行がここで
              CONNECT_TERM と同じ「つなぐ設定（DNS設定）」の形になる。 */}
          <span className="ml-1 text-[12px] font-normal text-muted-foreground">（{part.term}）</span>
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{note}</p>
      </div>
      <span
        className={`shrink-0 text-[12px] font-medium ${
          status === 'done' ? 'text-green-deep' : 'text-muted-foreground'
        }`}
      >
        {EASY_JOURNEY_STATUS_LABEL[status]}
      </span>
    </li>
  )
}

export function EasyDonePage() {
  const gate = useEasyDoneGate()
  const navigate = useNavigate()
  const { session, finish } = useEasy()

  if (gate) return gate

  const domainName = session.domainName
  const managementPath = `/mypage/domains/${encodeURIComponent(domainName)}`
  const dnsPath = `/domains/${encodeURIComponent(domainName)}/dns`
  const service = session.dnsServiceId ? serviceById(session.dnsServiceId) : undefined
  /**
   * ⚠️ この画面に来る人は 2 通りではなく **3 通り**いる。
   *   a. レコードを保存した人 ………………… skipped=false / connected=true
   *   b. 「あとで設定する」で抜けた人 ……… skipped=true  / connected=false
   *   c. ns-guide のサービス（Cloudflare・エックスサーバー）を選び、NS 変更の
   *      案内側へ出ていった人 ………………… skipped=false / connected=false
   * c は `dnsPlan` が 'later' ではないまま（使いみちは選んでいる）レコードを
   * 1 件も持たない状態で、`/easy` からの再開（useEasyEntryRedirect）でここへ来る。
   *
   * ⚠️ かつて見出し側だけを `skipped` で分けていたため、c の人の画面に
   * 「つなぐ設定まで終わりました」と、同じ画面のチェックリスト③「まだです」が
   * 同居していた。**見出し・サブライン・バナー・カード・ボタンは、レコードが
   * 実際に書かれたかを見る `connected` で分けること**（`skipped` で分けない）。
   */
  const skipped = session.dnsPlan === 'later'
  /* 貼り付けパーサで設定した人はレシピを持たない。「つなぎ先」を空にはしない。 */
  const pasted = session.dnsServiceId === EASY_PASTE_SERVICE_ID
  const usesMail = session.dnsPlan === 'mail' || session.dnsPlan === 'both'
  /* ③ つなぐ設定が実際に保存されたか。この画面の表示はすべてここで分ける。
     ⚠️ `dnsPlan !== 'later'` だけで判定しないこと。ns-guide のサービス
     （Cloudflare・エックスサーバー）はこの画面ではレコードを 1 件も保存せず、
     NS 変更の案内だけを出す（上の c）。レコードが実際に書かれた経路
     （レシピ or 貼り付け）だけを「済み」と数える。 */
  const connected = !skipped && (pasted || service?.mode === 'records')

  /**
   * ⚠️ `place`（サイトの置き場所）を done/todo に倒さないこと。当サービスは
   * 利用者が別のサービスで契約した置き場所を見る手段を持たないので、どちらに
   * 倒しても、置き場所を持っている人か持っていない人のどちらかに嘘をつく。
   */
  function journeyStatusOf(part: EasyJourneyPart): EasyJourneyPartStatus {
    if (part.id === 'domain') return 'done'
    if (part.id === 'place') return 'unknown'
    return connected ? 'done' : 'todo'
  }

  function journeyNoteOf(part: EasyJourneyPart): string {
    if (part.id === 'domain') return EASY_DONE_DOMAIN_NOTE
    if (part.id === 'place') return EASY_DONE_PLACE_NOTE
    return connected ? EASY_DONE_CONNECT_DONE_NOTE : EASY_DONE_CONNECT_TODO_NOTE
  }

  function goToManagement() {
    /* finish() は保存を消すだけで、メモリ上の session には触れない。
       ここで session まで空にすると、react-router の遷移が transition として
       遅れて適用される間に useEasyDoneGate が先に走り、「注文が無い」と判断して
       ウィザードの先頭へ差し戻してしまう。 */
    finish()
    navigate(managementPath)
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-none bg-accent">
            <CircleCheck className="size-5 text-primary" aria-hidden="true" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">
            {connected ? DONE_HEADING_CONNECTED : DONE_HEADING_SKIPPED}
          </h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          <strong className="font-mono text-foreground">{domainName}</strong>{' '}
          {connected ? DONE_SUBLINE_CONNECTED : DONE_SUBLINE_SKIPPED}
        </p>
      </header>

      {connected ? null : <StatusBanner tone="info">{DONE_DNS_SKIPPED_NOTE}</StatusBanner>}

      <Card>
        <CardHeader>
          <CardTitle>設定した内容</CardTitle>
        </CardHeader>
        <CardContent>
          {/* ⚠️ ここにドメイン名の行を置かない。見出しのすぐ下に同じ名前が
              大きく出ているので、1 行目から重複が始まる表になる。 */}
          <dl className="divide-y divide-border">
            {/* ⚠️ この行だけは `connected` ではなく `skipped` で分ける。揃っていない
                のはバグではない。上の c（ns-guide で抜けた人）は使いみち自体は
                選んでおり、そこへ DONE_PLAN_UNSET（'まだ決めていません'）を出すと
                今度はこちらが嘘になる。行ごとに答える問いが違う:
                この行は「何に使うと言ったか」、ほかは「つなぐ設定を保存したか」。 */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-3">
              <dt className="text-sm text-muted-foreground">使いみち</dt>
              <dd className="text-sm font-medium">
                {skipped ? DONE_PLAN_UNSET : dnsPlanLabel(session.dnsPlan)}
              </dd>
            </div>
            {/* ⚠️ この行名は `connected` で切り替える。ネームサーバーの案内へ出た人は
                サービスを **選んだだけ** でレコードを 1 件も保存していないので、
                「つないだ先：Cloudflare」と出すと、すぐ下のチェックリストの
                「つなぐ設定：まだです」と正面から矛盾する。保存できた人だけが
                「つないだ先」で、それ以外は「選んだサービス」。 */}
            {service || pasted ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pt-3">
                <dt className="text-sm text-muted-foreground">
                  {connected ? EASY_DONE_TARGET_CONNECTED_LABEL : EASY_DONE_TARGET_CHOSEN_LABEL}
                </dt>
                <dd className="text-sm font-medium">
                  {service ? service.service : DONE_TARGET_PASTED}
                </dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {/* ⚠️ 「で、サイトは見えるようになったのか？」への正直な答え。ここを
          「完了しました」で閉じないこと（ファイル冒頭の ⚠️ を参照）。締めの 1 行は
          状態で変えるが、待ち時間には触れない — 数分〜48時間の話は下の
          DONE_PROPAGATION_NOTE が言っており、同じことを 2 度書かない。 */}
      <Card>
        <CardHeader>
          <CardTitle>{EASY_DONE_JOURNEY_HEADING}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="list-none divide-y divide-border p-0">
            {EASY_JOURNEY_PARTS.map((part) => (
              <EasyJourneyRow
                key={part.id}
                part={part}
                status={journeyStatusOf(part)}
                note={journeyNoteOf(part)}
              />
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {connected ? EASY_DONE_CONNECTED_CONCLUSION : EASY_DONE_PENDING_CONCLUSION}
          </p>
        </CardContent>
      </Card>

      {/* この画面の本体。「見えるようになったのか」に、ユーザーの言葉で答える。 */}
      {connected ? (
        <Card>
          <CardHeader>
            <CardTitle>{DONE_VISIBLE_HEADING}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">{DONE_PROPAGATION_NOTE}</p>
            {/* ⚠️ メールだけは当サービスで確認できる範囲が狭い（§6.2.2）。 */}
            {usesMail ? (
              <p className="text-sm leading-relaxed text-muted-foreground">{DONE_MAIL_NOTE}</p>
            ) : null}
            <div className="space-y-1.5 bg-grass-1/60 px-3 py-2.5">
              <p className="text-sm font-medium">{DONE_CHECK_HEADING}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{DONE_CHECK_NOTE}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{DONE_NEXT_HEADING}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-none space-y-2 p-0">
              {CONNECT_TARGET_STEPS.map((step, index) => (
                <li key={step} className="flex items-start gap-2.5 bg-grass-1/60 px-3 py-2">
                  <span className="flex size-5 shrink-0 items-center justify-center bg-grass-2 text-[12px] font-bold text-green-deep">
                    {index + 1}
                  </span>
                  <span className="text-[13px] leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* ⚠️ つないだ人には「確認する」を約束したので、2 番目のボタンもその言葉で
          名乗る。「自分で細かく設定する」は同じ行き先だが、この人が言われ続けて
          きた「自分でやらなくていい」と正面から矛盾するので、リンクへ落とす。
          つないでいない人には確認するものが無いので、従来のままにする。
          ⚠️ ここも `skipped` ではなく `connected` で分ける。約束（DONE_CHECK_NOTE）を
          出すのは上の connected 側のカードなので、ボタンだけ別の判定で名乗ると、
          「つながったか確認する」が、確かめかたの案内が無い画面に独りで残る。 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="lg" onClick={goToManagement}>
          {DONE_TO_MYPAGE_ACTION}
        </Button>
        <Button variant="outline" asChild>
          <Link to={dnsPath}>{connected ? DONE_CHECK_ACTION : DONE_MANUAL_LINK}</Link>
        </Button>
        {connected ? (
          <Button variant="link" className="h-auto p-0 text-[13px] font-medium" asChild>
            <Link to={dnsPath}>{DONE_MANUAL_LINK}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
