/**
 * Polls GET /api/orders/{id} until Order.state settles (done / failed).
 *
 * Provisional contract (README 未合意事項): the create response does not carry
 * the final outcome, so the result screen polls. If the backend team later
 * chooses a synchronous response or push channel instead, only this hook and
 * api/ordersApi.ts change.
 */
import { useEffect, useState } from 'react'
import { isApiError } from '../../api/apiError'
import { fetchOrder, type Order } from '../../api/ordersApi'
import { orderPollIntervalMs } from '../../config'

const SETTLED_STATES: ReadonlySet<Order['state']> = new Set(['done', 'failed'])

/** Surface an error only when the order was never seen at all. */
const MAX_CONSECUTIVE_FAILURES_BEFORE_FIRST_RESULT = 3

export type OrderPollingState = {
  order: Order | null
  /**
   * 'not-found'    - the id does not exist (or is another member's, §7.3).
   * 'unavailable'  - repeated fetch failures before the order was ever loaded.
   *                  Polling continues behind the banner: the server may still
   *                  be working on the order (its callable deadline is longer
   *                  than one poll), so a later success clears the error.
   * Transient failures after a successful load keep the last known state and
   * keep polling.
   */
  error: 'not-found' | 'unavailable' | null
}

type InternalPollingState = OrderPollingState & {
  /** Stamped so a stale result from a previous orderId is never shown. */
  forOrderId: string
}

export function useOrderPolling(orderId: string): OrderPollingState {
  const [state, setState] = useState<InternalPollingState>({ forOrderId: orderId, order: null, error: null })

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let consecutiveFailures = 0
    let hasLoadedOnce = false

    async function poll() {
      let settled = false
      try {
        const order = await fetchOrder(orderId, controller.signal)
        hasLoadedOnce = true
        consecutiveFailures = 0
        settled = SETTLED_STATES.has(order.state)
        setState({ forOrderId: orderId, order, error: null })
      } catch (error) {
        if (controller.signal.aborted) return
        if (isApiError(error) && error.kind === 'notFound') {
          setState({ forOrderId: orderId, order: null, error: 'not-found' })
          return
        }
        consecutiveFailures += 1
        if (!hasLoadedOnce && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES_BEFORE_FIRST_RESULT) {
          setState({ forOrderId: orderId, order: null, error: 'unavailable' })
        }
      }
      if (!settled && !controller.signal.aborted) {
        timer = setTimeout(() => void poll(), orderPollIntervalMs())
      }
    }

    void poll()

    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [orderId])

  if (state.forOrderId !== orderId) return { order: null, error: null }
  return { order: state.order, error: state.error }
}
