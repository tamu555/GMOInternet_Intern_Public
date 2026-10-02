import { setupWorker } from 'msw/browser'
import { handlers, sessionMockHandlers } from './handlers'

// Real local dev talks to the actual Cookie-session backend (Vite's
// /api/session/* proxy -> the Functions emulator) - only handlers.ts's
// sessionMockHandlers are excluded here; the Node test server (server.ts)
// has no real backend at all and keeps them. See sessionMockHandlers' own
// comment in handlers.ts for the full rationale.
const sessionHandlerSet = new Set<(typeof handlers)[number]>(sessionMockHandlers)

export const worker = setupWorker(...handlers.filter((handler) => !sessionHandlerSet.has(handler)))
