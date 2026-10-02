/**
 * かんたんモードの Context 型。実装は EasyProvider.tsx（auth/authContext.ts と
 * signup/signupContext.ts と同じ「型と実装を分ける」分割）。
 */
import { createContext } from 'react'
import type { EasyDnsPlanKind, EasyNameCandidate, EasyPurposeKind, EasySession, EasyStepId } from './easyTypes'

export type EasyContextValue = {
  session: EasySession
  /** 完了済みステップ（保存値ではなく session から導出したもの）。 */
  completedSteps: EasyStepId[]
  /**
   * ステップごとの入力エラー。ステップナビゲーションの「入力エラー」表示に使う。
   * 永続化しない — エラーは「いまこの操作で起きたこと」であって下書きではない。
   */
  stepErrors: Partial<Record<EasyStepId, string>>
  setStepError: (step: EasyStepId, message: string | null) => void

  choosePurpose: (purpose: EasyPurposeKind, note: string) => void
  saveCandidates: (candidates: EasyNameCandidate[]) => void
  toggleFavorite: (label: string) => void
  chooseLabel: (label: string) => void
  chooseTld: (tld: string) => void
  setYears: (years: number) => void
  setAutoRenew: (autoRenew: boolean) => void
  chooseDnsPlan: (plan: EasyDnsPlanKind | null) => void
  chooseDnsService: (serviceId: string | null) => void
  setDnsInput: (key: string, value: string) => void
  /** createOrder 成功直後に呼ぶ。注文の事実ではなく「どの注文を見ればよいか」を残す。 */
  recordOrder: (orderId: string, domainName: string) => void
  /**
   * 契約・設定が完了したときに一時保存（localStorage）だけを破棄する。
   * メモリ上の session はそのまま残す — 完了画面を表示したまま session を空に
   * すると、ステップガードが「注文が無い」と判断して先頭へ差し戻してしまう。
   */
  finish: () => void
  /** 「入力内容を消してやり直す」。保存もメモリ上の状態も初期化する。 */
  reset: () => void
}

export const EasyContext = createContext<EasyContextValue | null>(null)
