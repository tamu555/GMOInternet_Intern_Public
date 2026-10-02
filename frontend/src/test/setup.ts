import '@testing-library/jest-dom/vitest'

/**
 * Node 25 exposes a stub `globalThis.localStorage` (it is inert unless the
 * process was started with --localstorage-file), and it wins over the working
 * Storage that jsdom installs on the window. Without this shim every
 * localStorage call in the app hits the silent catch branch, and the session
 * restore tests would pass for the wrong reason.
 */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, String(value))
    },
    removeItem: (key: string) => {
      entries.delete(key)
    },
    clear: () => {
      entries.clear()
    },
  } as Storage
}

function ensureWorkingStorage(name: 'localStorage' | 'sessionStorage'): void {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined
  if (typeof current?.getItem === 'function' && typeof current.clear === 'function') return

  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true })
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true })
  }
}

ensureWorkingStorage('localStorage')
ensureWorkingStorage('sessionStorage')

/**
 * jsdom ships no ResizeObserver, but Radix primitives (e.g. the Checkbox's
 * hidden bubble input) call it on mount. A no-op stand-in is enough - no test
 * asserts on resize behaviour.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
}

/**
 * jsdom implements neither elementFromPoint (input-otp polls it from a timer)
 * nor scrollIntoView. Both are layout concerns no assertion depends on.
 */
if (typeof document !== 'undefined') {
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null
  }
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = () => {}
  }
}

/**
 * jsdom has no layout, so window.scrollTo is a stub that logs a loud
 * "Not implemented" error to the virtual console on every call. EasyShell
 * scrolls to the top on each wizard step, which would drown the run in that
 * noise. Scroll position is a layout concern no assertion depends on, so
 * replace it with a real no-op (the app's own try/catch cannot silence this -
 * jsdom logs instead of throwing).
 */
if (typeof window !== 'undefined') {
  window.scrollTo = (() => {}) as typeof window.scrollTo
}
