/** Node-side MSW server: the tests run against the same handlers as the browser. */
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
