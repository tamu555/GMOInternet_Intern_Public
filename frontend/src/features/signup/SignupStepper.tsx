/**
 * Registration progress stepper: 1 アカウント作成 → 2 メール認証 →
 * 3 契約者情報 → 4 内容確認.
 *
 * The visual lives in the shared {@link ProgressSteps} (one look for every
 * wizard in the app: signup, DNS setup and かんたんモード). Only the
 * "everything is finished" case is resolved here, because `'complete'` sits
 * past the last entry of `SIGNUP_STEPS`.
 */
import { ProgressSteps } from '../../components/ProgressSteps'
import { SIGNUP_STEPS, type SignupStepId } from './signupTypes'

export function SignupStepper({ current }: { current: SignupStepId }) {
  // 'complete' is past the last stepper entry: every step renders as done.
  const currentIndex =
    current === 'complete' ? SIGNUP_STEPS.length : SIGNUP_STEPS.findIndex((step) => step.id === current)

  return (
    <ProgressSteps
      steps={SIGNUP_STEPS}
      currentIndex={currentIndex}
      label="登録の進行状況"
      align="center"
    />
  )
}
