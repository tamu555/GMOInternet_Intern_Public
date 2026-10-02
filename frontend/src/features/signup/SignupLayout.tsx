/**
 * Shared shell for the /signup/* wizard: mounts SignupProvider once (so
 * moving between steps never loses input) and renders the progress stepper
 * above the active step.
 */
import { Outlet, useLocation } from 'react-router-dom'
import { SignupProvider } from './SignupProvider'
import { SignupStepper } from './SignupStepper'
import type { SignupStepId } from './signupTypes'

function stepFromPathname(pathname: string): SignupStepId {
  if (pathname.endsWith('/verify')) return 'verify'
  if (pathname.endsWith('/contract')) return 'contract'
  if (pathname.endsWith('/confirm')) return 'confirm'
  if (pathname.endsWith('/complete')) return 'complete'
  return 'account'
}

export function SignupLayout() {
  const location = useLocation()

  return (
    <SignupProvider>
      <div className="mx-auto w-full max-w-2xl space-y-6 px-1 pt-6 pb-16 sm:pt-10">
        <SignupStepper current={stepFromPathname(location.pathname)} />
        <Outlet />
      </div>
    </SignupProvider>
  )
}
