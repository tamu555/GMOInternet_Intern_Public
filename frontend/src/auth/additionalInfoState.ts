/**
 * Marks a Google sign-in whose `sessionLogin` call came back
 * `additional_info_required` (no Cookie session exists yet). Mirrors
 * `tokenStorage.ts`'s plain-module pattern, but `sessionStorage`-backed
 * rather than `localStorage`: the marker only needs to survive the
 * `/signup/additional-info` round trip within this tab, never a future visit.
 */
const STORAGE_KEY = 'registrar.auth.additionalInfoPending'

export type AdditionalInfoPending = {
  uid: string
  email: string
}

export function saveAdditionalInfoPending(pending: AdditionalInfoPending): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
  } catch {
    // Private mode / disabled storage: the RequireAdditionalInfo guard falls
    // back to Firebase's own `currentUser` check.
  }
}

export function readAdditionalInfoPending(): AdditionalInfoPending | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AdditionalInfoPending>
    if (typeof parsed.uid !== 'string' || typeof parsed.email !== 'string') return null
    return { uid: parsed.uid, email: parsed.email }
  } catch {
    return null
  }
}

export function clearAdditionalInfoPending(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}
