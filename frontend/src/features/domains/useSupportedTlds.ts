/**
 * Loads the supported-TLD list from the backend (spec §4.3: fetched at
 * startup, never hardcoded). Falls back to a static list only when the fetch
 * itself fails - the same "cache it, fall back on failure" shape spec §4.3
 * describes for the backend's own TLD routing map, applied here to the
 * frontend's copy of it.
 */
import { useEffect, useState } from 'react'
import { fetchSupportedTlds } from '../../api/domainsSearchApi'
import { FALLBACK_TLDS } from './constants'

export type SupportedTldsState = {
  tlds: string[]
  loading: boolean
  /** True once the fetch has failed and the static fallback list is in use. */
  usingFallback: boolean
}

export function useSupportedTlds(): SupportedTldsState {
  const [state, setState] = useState<SupportedTldsState>({ tlds: [], loading: true, usingFallback: false })

  useEffect(() => {
    const controller = new AbortController()

    fetchSupportedTlds(controller.signal)
      .then((response) => {
        setState({ tlds: response.tlds, loading: false, usingFallback: false })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setState({ tlds: [...FALLBACK_TLDS], loading: false, usingFallback: true })
      })

    return () => controller.abort()
  }, [])

  return state
}
