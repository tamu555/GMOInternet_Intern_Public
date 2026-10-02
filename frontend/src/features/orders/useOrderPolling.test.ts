/**
 * useOrderPolling tests, mocked at the fetchOrder seam (api/ordersApi).
 *
 * The 'unavailable' recovery case is the regression test for the "注文状況を
 * 確認できませんでした" bug: the server's callable deadline outlives a single
 * client attempt, so the hook must keep polling behind the error banner and
 * recover once getOrder finally answers - instead of stopping forever while
 * the order quietly completes server-side (and shows up in MyPage).
 */
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/apiError'
import type { Order } from '../../api/ordersApi'
import { useOrderPolling } from './useOrderPolling'

const fetchOrderMock = vi.fn<(orderId: string, signal?: AbortSignal) => Promise<Order>>()

vi.mock('../../api/ordersApi', () => ({
  fetchOrder: (orderId: string, signal?: AbortSignal) => fetchOrderMock(orderId, signal),
}))

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>()
  return { ...actual, orderPollIntervalMs: () => 5 }
})

function order(state: Order['state']): Order {
  return {
    id: 'order-1',
    kind: 'create',
    domainName: 'a.com',
    state,
    years: 1,
    autoRenew: true,
    priceYen: 1000,
  }
}

const networkError = () => new ApiError({ kind: 'network', status: 0 })
const notFoundError = () => new ApiError({ kind: 'notFound', status: 404 })

function callCountAfterSettling(): Promise<number> {
  // Three poll intervals with no new call = polling has genuinely stopped.
  const settledCount = fetchOrderMock.mock.calls.length
  return new Promise((resolve) =>
    setTimeout(() => resolve(fetchOrderMock.mock.calls.length - settledCount), 50),
  )
}

beforeEach(() => {
  fetchOrderMock.mockReset()
})

describe('useOrderPolling', () => {
  it('shows unavailable after repeated failures but keeps polling and recovers', async () => {
    fetchOrderMock.mockRejectedValue(networkError())

    const { result } = renderHook(() => useOrderPolling('order-1'))

    await waitFor(() => expect(result.current.error).toBe('unavailable'))
    expect(result.current.order).toBeNull()

    // The bug: polling used to stop here forever. It must retry and recover.
    fetchOrderMock.mockResolvedValue(order('done'))
    await waitFor(() => expect(result.current.order?.state).toBe('done'))
    expect(result.current.error).toBeNull()
  })

  it('stops polling with not-found when the id does not exist', async () => {
    fetchOrderMock.mockRejectedValue(notFoundError())

    const { result } = renderHook(() => useOrderPolling('order-1'))

    await waitFor(() => expect(result.current.error).toBe('not-found'))
    await expect(callCountAfterSettling()).resolves.toBe(0)
  })

  it('keeps the last known order through transient failures after a first load', async () => {
    fetchOrderMock.mockResolvedValueOnce(order('provisioning')).mockRejectedValue(networkError())

    const { result } = renderHook(() => useOrderPolling('order-1'))

    await waitFor(() => expect(result.current.order?.state).toBe('provisioning'))
    // Well past MAX_CONSECUTIVE_FAILURES_BEFORE_FIRST_RESULT worth of failures.
    await waitFor(() => expect(fetchOrderMock.mock.calls.length).toBeGreaterThan(5))
    expect(result.current.order?.state).toBe('provisioning')
    expect(result.current.error).toBeNull()
  })

  it('stops polling once the order settles', async () => {
    fetchOrderMock.mockResolvedValue(order('done'))

    const { result } = renderHook(() => useOrderPolling('order-1'))

    await waitFor(() => expect(result.current.order?.state).toBe('done'))
    await expect(callCountAfterSettling()).resolves.toBe(0)
  })
})
