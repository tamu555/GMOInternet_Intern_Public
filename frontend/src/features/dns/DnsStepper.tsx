/**
 * DNS設定フローの進行表示。並びは dnsEditorSteps.ts が持ち、モードごとに
 * 別の並び（DNS_INTRO_STEPS / DNS_EDITOR_STEPS / DNS_NS_STEPS）を渡す。
 *
 * 見た目は共有の {@link ProgressSteps} に一本化してある（会員登録・かんたんモードと
 * 同じ 1 本）。アプリ全体で「進行中のフロー」の見え方が 1 種類になるようにするため。
 */
import { ProgressSteps } from '../../components/ProgressSteps'
import type { DnsStep } from './dnsEditorSteps'

export function DnsStepper({ steps, current }: { steps: readonly DnsStep[]; current: string }) {
  return (
    <ProgressSteps
      steps={steps}
      currentIndex={steps.findIndex((step) => step.id === current)}
      label="DNS設定の進行状況"
    />
  )
}
