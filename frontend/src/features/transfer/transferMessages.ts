/**
 * 移管IN (§6.6.2) fixed wordings. The flow's core promise is walking a
 * beginner through the AuthCode hurdle (仕様: 初心者にとって最大の難所), so the
 * guide sentences stay on the explanatory side on purpose.
 */

/** §6.6.2 step 2: 移管元での AuthCode 発行の案内. */
export const AUTH_CODE_GUIDE_TITLE = 'AuthCode（認証コード）を用意してください'
export const AUTH_CODE_GUIDE_STEPS = [
  '今このドメインを管理している会社（移管元）の管理画面にログインします。',
  '「AuthCode」「認証コード」「移管コード」などの名前のコードを発行・表示します。',
  '表示されたコードをコピーして、下の入力欄に貼り付けます。',
] as const
export const AUTH_CODE_GUIDE_NOTE =
  '見つからないときは、移管元のヘルプで「移管」「AuthCode」を検索してください。移管ロック（transfer lock）が有効な場合は、先に移管元で解除が必要です。'

/** §6.6.2 step 4: 申請後の進捗表示. */
export const TRANSFER_IN_PENDING_NOTE =
  '移管元の承認待ちです。承認されると、このドメインは自動的にあなたのドメイン一覧に追加されます。'

/**
 * §6.6.1 ⚠️ 20分自動承認 — 移管IN側から見た説明。移管元が応答しないまま期限を
 * 過ぎるとレジストリが代わりに承認するため、「待つだけでよい」ことを伝える.
 */
export function transferInAutoApproveNote(deadline: string): string {
  return `移管元が応答しない場合も、${deadline} にレジストリが自動で承認します。`
}

/** 移管元が承認したとき（完了）の通知. */
export const TRANSFER_IN_APPROVED_NOTE =
  '移管が完了しました。ドメイン一覧への反映まで少し時間がかかることがあります。'

/** 移管元が拒否したときの通知. */
export const TRANSFER_IN_REJECTED_NOTE =
  '移管元がこの申請を承認しませんでした。AuthCodeや移管ロックの状態を移管元で確認して、もう一度お試しください。'

/** 取り下げ確認ダイアログ (§6.6.1: gaining は承認前なら cancel 可能). */
export const TRANSFER_IN_CANCEL_CONFIRM =
  '移管の申請を取り下げます。ドメインは移管元の管理のまま変わりません。'
