/**
 * 退会（アカウント削除）まわりの固定文言 (docs/仕様/auth.md §4.8-4.9).
 * `mypageMessages.ts` と同じ理由でここに集約する: ドメインの「もう使わない」
 * とは別の粒度（アカウント全体）の削除なので、文言も別ファイルに分けている。
 *
 *   - §4.9: 退会 → pending_deletion（30日間）→ purging → 完全削除。
 *     30日以内は復元できる (restoreAccount) が、この画面からは導線を出さない
 *     （復元はサポート導線 - 退会直後の画面に「取り消せます」の一文だけ残す）。
 */

/** §4.8 削除確認ダイアログ1段目: 影響の明示（必須表示）. */
export const ACCOUNT_DELETE_IMPACT_WARNING =
  '退会すると、このアカウントでのログインやドメインの管理ができなくなります。'

/**
 * §4.9 30日間の猶予期間説明（削除確定前に必須表示）。
 * 保有ドメインがある場合は退会自体ができない（後述の
 * ACCOUNT_DELETE_DOMAINS_OWNED_MESSAGE）が、ドメインは退会によって自動的に
 * 削除・移管されるわけではないため、その前提をここで明示する。
 */
export const ACCOUNT_DELETE_GRACE_EXPLANATION =
  '退会後30日間はサポートへのご連絡で取り消せます。この期間を過ぎるとアカウントとデータは完全に削除され、復元できなくなります。' +
  '保有中のドメインがある場合は退会できません。ドメインは退会時に自動で削除・移管されることはないため、あらかじめドメインの廃止または移管を済ませてください。'

export const ACCOUNT_DELETE_PASSWORD_LABEL = 'パスワード'
export const ACCOUNT_DELETE_PASSWORD_PLACEHOLDER = '現在のパスワード'

export const ACCOUNT_DELETE_WRONG_PASSWORD_MESSAGE = 'パスワードが正しくありません。'
export const ACCOUNT_DELETE_REAUTH_FAILED_MESSAGE =
  '本人確認に失敗しました。時間をおいて再度お試しください。'
export const ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE =
  '確認の有効期限が切れました。もう一度やり直してください。'
export const ACCOUNT_DELETE_PROVIDER_MISMATCH_MESSAGE = 'この操作を行える状態ではありません。'

export const ACCOUNT_DELETE_SUCCESS_MESSAGE =
  '退会の手続きを受け付けました。30日以内であればサポートまでご連絡でアカウントを復元できます。'

/**
 * 保有ドメインによる退会ブロック（functions/src/auth/account-lifecycle.ts の
 * failed-precondition / details.reason === 'domains_owned' と対になる文言）。
 *
 * 二箇所で使う: (1) ダイアログを開いた時点のフロント側事前チェック
 * (listDomains) が保有ドメインを見つけた場合の StatusBanner、
 * (2) バックエンドが同じ理由で拒否した場合（事前チェック後の競合状態や、
 * 事前チェック自体が失敗して先へ進んでしまった場合の保険）。どちらも同じ
 * 文言を返すのは意図的 — 画面に出るのがどちらの経路でも、会員には同じ説明
 * が見える。
 *
 * @param {number} count 保有中のドメイン件数。
 * @return {string} 表示する文言。
 */
export function accountDeleteDomainsOwnedMessage(count: number): string {
  return `保有中のドメインが${count}件あるため退会できません。先にドメインを廃止または移管してください。`
}
