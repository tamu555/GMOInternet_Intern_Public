import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeAssistantEngine } from '../engine/fakeAssistantEngine'
import { acquireDownloadLock } from '../engine/modelStatus'
import { subscribeAssistantEvents, type AssistantEvent } from '../events'

const { assistantEnabledMock } = vi.hoisted(() => ({ assistantEnabledMock: vi.fn(() => true) }))
vi.mock('../config/assistantConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/assistantConfig')>()
  return { ...actual, assistantEnabled: assistantEnabledMock }
})

// jsdom has no `navigator.gpu`, so `detectWebGpu()` would always resolve
// `{ available: false }` and every test would land in UNSUPPORTED. Every
// other export of `modelStatus.ts` stays real (localStorage-backed lock/
// consent/version helpers, hasEnoughStorage, isSlowConnection, ...).
const { detectWebGpuMock } = vi.hoisted(() => ({
  detectWebGpuMock: vi.fn(async () => ({ available: true, shaderF16: false })),
}))
vi.mock('../engine/modelStatus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/modelStatus')>()
  return { ...actual, detectWebGpu: detectWebGpuMock }
})

const {
  getModelSnapshot,
  grantDownloadConsent,
  resetModelStoreForTest,
  retryModelLoad,
  scheduleAssistantModelLoad,
  setEngineFactoryForTest,
  startAssistantModelLoad,
  subscribeModelState,
} = await import('./modelStore')

function setConnection(value: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, 'connection', { value, configurable: true })
}

beforeEach(() => {
  resetModelStoreForTest()
  assistantEnabledMock.mockReturnValue(true)
  detectWebGpuMock.mockResolvedValue({ available: true, shaderF16: false })
  window.localStorage.clear()
  setConnection(undefined)
})

describe('happy path', () => {
  it('runs NOT_STARTED -> CHECKING -> DOWNLOADING -> INITIALIZING -> READY', async () => {
    expect(getModelSnapshot().status).toBe('NOT_STARTED')

    const seen: string[] = []
    const unsubscribe = subscribeModelState(() => seen.push(getModelSnapshot().status))
    setEngineFactoryForTest(() => createFakeAssistantEngine({ loadSteps: 2 }))

    await startAssistantModelLoad()

    expect(getModelSnapshot().status).toBe('READY')
    const order = ['CHECKING', 'DOWNLOADING', 'INITIALIZING', 'READY']
    const indices = order.map((status) => seen.indexOf(status))
    expect(indices.every((index) => index !== -1)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))

    unsubscribe()
  })

  it('is a no-op once READY (does not reload the model)', async () => {
    const fake = createFakeAssistantEngine()
    setEngineFactoryForTest(() => fake)
    await startAssistantModelLoad()
    expect(fake.calls.load).toBe(1)

    await startAssistantModelLoad()
    expect(fake.calls.load).toBe(1)
  })
})

describe('failure and retry (§16)', () => {
  it('ends in ERROR, and retryModelLoad() goes back through CHECKING', async () => {
    setEngineFactoryForTest(() => createFakeAssistantEngine({ failLoad: true }))
    await startAssistantModelLoad()
    expect(getModelSnapshot()).toMatchObject({ status: 'ERROR', errorKind: 'load_failed' })

    const seen: string[] = []
    const unsubscribe = subscribeModelState(() => seen.push(getModelSnapshot().status))
    const retryPromise = retryModelLoad()
    expect(getModelSnapshot().status).toBe('CHECKING')
    await retryPromise
    expect(seen[0]).toBe('CHECKING')
    unsubscribe()
  })
})

describe('assistantEnabled() === false', () => {
  it('yields UNSUPPORTED and never constructs an engine', async () => {
    assistantEnabledMock.mockReturnValue(false)
    const factory = vi.fn(() => createFakeAssistantEngine())
    setEngineFactoryForTest(factory)

    await startAssistantModelLoad()

    expect(getModelSnapshot().status).toBe('UNSUPPORTED')
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('slow connection consent (§17.2)', () => {
  it('stops at AWAITING_CONSENT, and grantDownloadConsent() resumes to READY', async () => {
    setConnection({ effectiveType: '3g' })
    const fake = createFakeAssistantEngine()
    setEngineFactoryForTest(() => fake)

    await startAssistantModelLoad()
    expect(getModelSnapshot().status).toBe('AWAITING_CONSENT')
    expect(fake.calls.load).toBe(0)

    await grantDownloadConsent()
    expect(getModelSnapshot().status).toBe('READY')
    expect(fake.calls.load).toBe(1)
  })
})

describe('cross-tab download lock (§6.5)', () => {
  it('stays at CHECKING with lockedByOtherTab=true while another tab holds a live lock', async () => {
    acquireDownloadLock('other-tab', Date.now())
    const fake = createFakeAssistantEngine()
    setEngineFactoryForTest(() => fake)

    await startAssistantModelLoad()

    expect(getModelSnapshot()).toMatchObject({ status: 'CHECKING', lockedByOtherTab: true })
    expect(fake.calls.load).toBe(0)
  })
})

describe('§20.1 events', () => {
  it('fires model_load_started/completed on success', async () => {
    const events: AssistantEvent[] = []
    const unsubscribe = subscribeAssistantEvents((event) => events.push(event))
    setEngineFactoryForTest(() => createFakeAssistantEngine())

    await startAssistantModelLoad()

    expect(events.map((event) => event.type)).toEqual(['model_load_started', 'model_load_completed'])
    expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0)
    unsubscribe()
  })

  it('fires model_load_started/failed on a failing load', async () => {
    const events: AssistantEvent[] = []
    const unsubscribe = subscribeAssistantEvents((event) => events.push(event))
    setEngineFactoryForTest(() => createFakeAssistantEngine({ failLoad: true }))

    await startAssistantModelLoad()

    expect(events.map((event) => event.type)).toEqual(['model_load_started', 'model_load_failed'])
    unsubscribe()
  })
})

describe('FR-17: no network traffic caused by the store itself', () => {
  it('never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    setEngineFactoryForTest(() => createFakeAssistantEngine())

    await startAssistantModelLoad()

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('scheduleAssistantModelLoad', () => {
  it('is a no-op when the assistant is disabled', () => {
    assistantEnabledMock.mockReturnValue(false)
    const factory = vi.fn(() => createFakeAssistantEngine())
    setEngineFactoryForTest(factory)

    scheduleAssistantModelLoad()

    expect(getModelSnapshot().status).toBe('NOT_STARTED')
    expect(factory).not.toHaveBeenCalled()
  })
})
