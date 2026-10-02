import { useContext } from 'react'
import { EasyContext, type EasyContextValue } from './easyContext'

export function useEasy(): EasyContextValue {
  const value = useContext(EasyContext)
  if (!value) {
    throw new Error('useEasy must be used inside <EasyProvider>')
  }
  return value
}
