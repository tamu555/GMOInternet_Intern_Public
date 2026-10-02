import { useContext } from 'react'
import { SignupContext, type SignupContextValue } from './signupContext'

export function useSignup(): SignupContextValue {
  const value = useContext(SignupContext)
  if (!value) {
    throw new Error('useSignup must be used inside <SignupProvider>')
  }
  return value
}
