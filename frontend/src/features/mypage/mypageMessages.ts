/**
 * My-page fixed wordings. Several of these are SPEC-FIXED sentences, not
 * copywriting preferences - do not "improve" them:
 *   - NS change warning (§6.3.3(e)): must mention that mail stops too.
 *   - Delete impact (§6.5): must name both the website and mail.
 *   - The retire flow's recommended branch (§6.5): 期限まで使う is the default.
 */

/** §6.3.3(e) NS変更時の警告 - 初心者の事故トップクラス. */
export const NS_CHANGE_WARNING =
  'ネームサーバーを変更すると、このサービスで設定したDNSレコードは無効になります。メールも止まります。'

/** §6.5 削除確定前の影響明示（必須表示）. */
export const DELETE_IMPACT_WARNING = 'このドメインを使っているWebサイトとメールが止まります。'

/** §6.5 「もう使わない」の2択. */
export const RETIRE_KEEP_LABEL = '期限まで使って、そのあと自動で終わりにする'
export const RETIRE_KEEP_DESCRIPTION =
  '自動更新をOFFにします。期限まではこれまで通り使えて、追加の支払いは発生しません。'
export const RETIRE_NOW_LABEL = '今すぐ削除する'
export const RETIRE_NOW_DESCRIPTION = '期限を待たずに廃止します。猶予期間内なら復旧できます。'

/**
 * §6.5 猶予期間の説明（今すぐ削除時に必須表示）。
 * 45日 = 両レジストリが明記する grace-period-days。そのあと約5日間は
 * 「復旧できないまま残る」期間があり、そこを過ぎると名前が解放される.
 */
export const GRACE_PERIOD_EXPLANATION =
  '削除後、45日間は復旧できます。この期間を過ぎると復旧できなくなり、そのまま数日で第三者が取得できる状態になります。'

/** §6.5 復旧できる期間が終わったドメインの表示（一覧・詳細で共通）. */
export const RESTORE_WINDOW_ENDED_LABEL = '復旧できる期間が終了しました'
export const RESTORE_WINDOW_ENDED_NOTE =
  '復旧できる期間（45日）が終了したため、このドメインは元に戻せません。まもなく失効し、第三者が取得できる状態になります。'

/**
 * §6.4 / TBD #15: アプリの「自動更新OFF」はレジストリでは実現できず、期限日に
 * アプリ側バッチが delete を打つ方式。表示が嘘にならないよう仕組みを明記する.
 */
export const AUTO_RENEW_OFF_NOTE =
  'OFFにすると、期限日に当サービスが廃止手続きを行い、ドメインは期限まで使ってそのまま終了します。'

/** §6.4 複数年更新の提案 - 1年更新が最も失効リスクが高い. */
export const MULTI_YEAR_RENEWAL_HINT =
  '1年ごとの更新は失効リスクが最も高くなります。複数年でまとめての更新がおすすめです。'

/** §3.5 spec-fixed wording for inactive. */
export const INACTIVE_NOTICE =
  'まだインターネットに公開されていません。ネームサーバー（DNS）の設定をすると使い始められます。'

/** §6.6.1 ⚠️ 20分自動承認. */
export const TRANSFER_AUTO_APPROVE_WARNING =
  '応答しないまま放置すると、申請から20分後にサーバが自動で承認します。'

/**
 * 空き待ち通知 (docs/仕様/domain-watch.md): the notice invites, it does not
 * reserve. Several members may watch one name and it is first come first
 * served, so this caveat MUST accompany every 「空きが確認できました」.
 */
export const WATCH_AVAILABILITY_CAVEAT =
  '空き状況は変動する場合があります。他のお客様が先に取得されることもあるため、お早めにお手続きください。'
