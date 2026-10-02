/**
 * One-way channel: "the backend just told us the session is gone" (FIG.8).
 *
 * The HTTP client cannot import AuthProvider (React would be pulled into a
 * plain module and the import would be circular), so the client publishes here
 * and AuthProvider subscribes. This is what keeps 401 handling out of every
 * individual call site.
 */
type UnauthorizedListener = () => void

const listeners = new Set<UnauthorizedListener>()

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitUnauthorized(): void {
  for (const listener of [...listeners]) {
    listener()
  }
}
