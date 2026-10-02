/**
 * 「ドメインをつなぐ」手順の定義。DnsStepper（表示）と各モード（状態）が
 * 同じ並びを見るための単一の出どころ。
 *
 * ⚠️ ラベルは画面の内部フェーズ名（「設定の種類」「作り方を選ぶ」）ではなく、
 * 利用者にとっての区切りで名づける。初心者が途中で手を止める理由の多くは、
 * いま何番目にいて、あと何回画面が変わるのかが分からないこと自体にある。
 * 「使いみちを選ぶ」と「案内の見分け」は、本人にとっては同じ1歩（＝つなぎ先を
 * 決める）なので、どちらも 'mode' の段として数える。
 */
export type DnsStep = { readonly id: string; readonly label: string }

/**
 * どのモードでも共通の1歩目。3本の並びの先頭をそろえて地続きに見せる。
 * ラベルは短く保つ — 最長の並び（DNS_EDITOR_STEPS）で5段が1行に収まらないと、
 * 折り返しや「完…」の省略が起きて進行表示として読めなくなる。
 */
export const DNS_MODE_STEP: DnsStep = { id: 'mode', label: 'つなぎ先' }

/** モード未選択のあいだに見せる、モードに依らない3段の見取り図。 */
export const DNS_INTRO_STEPS: readonly DnsStep[] = [
  DNS_MODE_STEP,
  { id: 'intro-input', label: '内容を入力' },
  { id: 'intro-check', label: 'つながる' },
]

export type DnsEditorStep = 'method' | 'edit' | 'confirm' | 'done'

export const DNS_EDITOR_STEPS: readonly DnsStep[] = [
  DNS_MODE_STEP,
  { id: 'method', label: '入力の準備' },
  { id: 'edit', label: '内容を入力' },
  { id: 'confirm', label: '確認' },
  { id: 'done', label: 'つながる' },
]

export const DNS_NS_STEPS: readonly DnsStep[] = [
  DNS_MODE_STEP,
  { id: 'ns-input', label: '内容を入力' },
  { id: 'ns-done', label: 'つながる' },
]
