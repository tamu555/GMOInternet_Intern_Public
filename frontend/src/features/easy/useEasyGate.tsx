/**
 * ステップごとの前提条件ガード（signup の useSignupGate と同じ規約：
 * 要素が返ったら描画せず、その要素をそのまま返す）。
 *
 * 目的は 2 つ。
 *   1. 必要な入力が済んでいないステップへ直接来た場合（URL 直打ち・ブラウザバック・
 *      ブックマーク）に、進める最も先のステップへ差し戻す。
 *   2. 支払い済み（orderId がある）のに手前のステップへ戻ってきた場合に、
 *      注文をやり直させない。
 */
import { Navigate } from 'react-router-dom'
import {
  canEnterEasyStep,
  easyStepDef,
  easyStepIndex,
  furthestReachableStep,
  type EasyStepId,
} from './easyTypes'
import { useEasy } from './useEasy'

export function useEasyGate(step: EasyStepId): React.ReactElement | null {
  const { session } = useEasy()

  // 注文を発行したあとに「確認」「支払い」へ戻ると、同じドメインをもう一度
  // 買おうとする画面になる。発行済みなら常に DNS 設定（＝続き）へ送る。
  if (session.orderId !== null && easyStepIndex(step) < easyStepIndex('dns')) {
    return <Navigate to={easyStepDef('dns').path} replace />
  }

  if (!canEnterEasyStep(session, step)) {
    return <Navigate to={easyStepDef(furthestReachableStep(session)).path} replace />
  }

  return null
}

/** 完了画面（/easy/done）用のガード。注文が無ければウィザードへ戻す。 */
export function useEasyDoneGate(): React.ReactElement | null {
  const { session } = useEasy()
  if (session.orderId === null || session.domainName === '') {
    return <Navigate to={easyStepDef(furthestReachableStep(session)).path} replace />
  }
  return null
}

/* ⚠️ `useEasyEntryRedirect` は 2026-08-28 に廃止した（issue #91）。ルート `/easy`
   は「無言で続きへ飛ばす」場所ではなくなり、続きから進むか最初からやり直すかを
   本人に選ばせる画面（`EasyEntryPage`）になっている。ここに再入場の自動判定を
   書き戻さないこと。 */
