/**
 * Domain order API (docs/api-flow-diagrams.html FIG.1 right half), now over
 * Firebase callables — all three on the real backend (functions/):
 *
 *   kind=create -> callable `createOrder`
 *   kind=renew  -> callable `renewOrder`
 *   fetchOrder  -> callable `getOrder`
 *
 * Order.state carries at least the 4 user-visible phases of FIG.1's right
 * side: provisioning / retrying / done / failed (plus draft/paid, spec §5).
 * Never collapse this into a boolean - "retrying" has its own mandatory
 * wording (§6.7) and "failed" has its own screen.
 *
 * The 2302 recovery ("409 + 2302, but domain:info resolves for our registrar
 * = the previous attempt had already succeeded", FIG.2 / §6.7) is the
 * BACKEND's job: such an order reaches us simply as state="done" (its
 * `recovered` flag is deliberately not surfaced). The real createOrder
 * response also reports failure as a STATE, never as a thrown error.
 *
 * idempotencyKey (required by the real createOrder AND renewOrder): generated
 * here, one key per distinct form payload (stable JSON of kind + request), so
 * re-submitting the identical order after a network error reuses the key and
 * the backend's idempotent order store prevents a double charge. Editing the
 * form yields a new key (a different order intent). The backend also rejects
 * reusing one key across kinds - the kind-prefixed fingerprint prevents that.
 *
 * getOrder answers the real order document, so no client-side identity cache
 * is needed. Backend detail worth knowing: polling a non-terminal order also
 * RESUMES its provisioning attempt server-side (idempotent, attempt-capped)
 * — that is how a `retrying` order ever reaches done/failed, so keep polling
 * until the state settles.
 */
import { invoke } from './callable'

/** spec §5 Order.state machine (TBD #17 - draft below is the working set). */
export type OrderState = 'draft' | 'paid' | 'provisioning' | 'retrying' | 'done' | 'failed'

/**
 * spec §5 Order.kind. 'renew' reuses this same contract from the my-page
 * detail screen (FIG.10) so payment/retry/no-double-charge stay in one place.
 * restore/transfer orders are future extensions.
 */
export type OrderKind = 'create' | 'renew'

/** Roles all resolve to the member's per-registry contact for now (spec §5.1). */
export type ContactRoleAssignment = 'member-contact'

export type OrderContactRoles = {
  registrant: ContactRoleAssignment
  admin: ContactRoleAssignment
  tech: ContactRoleAssignment
  billing: ContactRoleAssignment
}

/**
 * The payload is ALWAYS complete (spec §1.2): fields hidden by easy-mode
 * masking or folded behind "くわしい設定" are still present, filled with the
 * §6.2.6 defaults. A partial payload is a bug in the caller.
 */
export type OrderCreateRequest = {
  kind: 'create'
  domainName: string
  years: number
  autoRenew: boolean
  /** 'none' (default) sends an empty `nameservers`: the domain is registered
   * as `inactive` and delegated later, so DNS can never fail a purchase. */
  nameserverMode: 'none' | 'custom'
  nameservers: string[]
  /** spec §3.4: 1-64 chars. */
  authInfo: string
  contacts: OrderContactRoles
}

/** FIG.10: 更新 (POST /domains/{name}/renew 相当) を Order として積む. */
export type OrderRenewRequest = {
  kind: 'renew'
  domainName: string
  /** 期間延長 (複数年更新の提案 §6.4). */
  years: number
  /**
   * The expiry the member saw when confirming (DomainDetailPage's live
   * `domain.exDate`). Part of the idempotency fingerprint, NOT sent to the
   * backend: a repeat of the same intent (same starting expiry) reuses the
   * same key and lands on the same order, while a deliberate second renewal
   * — confirmed against the already-extended expiry — gets a fresh key.
   */
  currentExDate: string
}

export type OrderedDomain = {
  name: string
  /** ISO 8601. */
  exDate: string
  /** spec §3.5 statuses, e.g. ["ok"] or ["inactive"] (NS not set yet). */
  statuses: string[]
  /** Masked on screen, copy-only (spec §7.3). */
  authInfo: string
}

export type Order = {
  id: string
  kind: OrderKind
  domainName: string
  state: OrderState
  years: number
  autoRenew: boolean
  /** Total charged by the pseudo payment (first year + renewals). */
  priceYen: number
  /** Present only when state === 'done'. */
  domain?: OrderedDomain
  /**
   * Raw EPP result.code the backend chose to surface on failure, mapped to
   * wording via api/eppResultMessages.ts. The real createOrder reports
   * failures with a human message only (no code), so this stays optional.
   */
  resultCode?: number
}

/** Wire shape of the real `createOrder` callable (functions/src/api/createOrder.ts). */
type BackendCreateOrderResponse = {
  orderId: string
  orderSeq: number
  priceYen: number
  state: OrderState
  domainName: string
  registry: string
  crDate?: string
  exDate?: string
  nameservers: string[]
  recovered: boolean
  message: string
}

/** Wire shape of the real `renewOrder` callable (functions/src/api/renewOrder.ts). */
type BackendRenewOrderResponse = {
  orderId: string
  orderSeq: number
  priceYen: number
  state: OrderState
  domainName: string
  registry: string
  exDate?: string
  recovered: boolean
  message: string
}

/**
 * One idempotencyKey per distinct order payload (see module doc comment).
 * 32 hex chars, matching the backend's /^[A-Za-z0-9_-]{8,64}$/ rule.
 */
const idempotencyKeys = new Map<string, string>()

/**
 * Renew keys additionally survive a page reload via sessionStorage: the
 * dangerous retry ("failure shown" → reload → submit again) must reuse the
 * same key so the backend resumes the same order instead of charging a
 * second renewal. Renew fingerprints carry no secrets (domain, years,
 * starting expiry), unlike create fingerprints (authInfo), which therefore
 * stay memory-only.
 */
const RENEW_KEY_STORAGE = 'ordersApi.renewIdempotencyKeys'

function loadStoredRenewKey(fingerprint: string): string | undefined {
  try {
    const raw = sessionStorage.getItem(RENEW_KEY_STORAGE)
    if (!raw) return undefined
    const record = JSON.parse(raw) as Record<string, unknown>
    const key = record[fingerprint]
    return typeof key === 'string' ? key : undefined
  } catch {
    return undefined
  }
}

function storeRenewKey(fingerprint: string, key: string): void {
  try {
    const raw = sessionStorage.getItem(RENEW_KEY_STORAGE)
    const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    record[fingerprint] = key
    sessionStorage.setItem(RENEW_KEY_STORAGE, JSON.stringify(record))
  } catch {
    // Storage unavailable (private mode, quota): the in-memory Map still
    // covers retries within this page's lifetime.
  }
}

/** Date part of an ISO datetime, so mirror/live format drift (date-only vs
 * `...T03:02:41Z`) cannot split one renewal intent into two fingerprints. */
function datePartOf(isoDate: string): string {
  const match = isoDate.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : isoDate
}

function idempotencyKeyFor(input: OrderCreateRequest | OrderRenewRequest): string {
  const fingerprint =
    input.kind === 'renew'
      ? JSON.stringify(['renew', input.domainName, input.years, datePartOf(input.currentExDate)])
      : JSON.stringify(['create', input.domainName, input.years, input.autoRenew, input.nameservers, input.authInfo])
  let key = idempotencyKeys.get(fingerprint)
  if (!key && input.kind === 'renew') {
    key = loadStoredRenewKey(fingerprint)
    if (key) idempotencyKeys.set(fingerprint, key)
  }
  if (!key) {
    key = crypto.randomUUID().replace(/-/g, '')
    idempotencyKeys.set(fingerprint, key)
    if (input.kind === 'renew') storeRenewKey(fingerprint, key)
  }
  return key
}

function orderFromCreateResponse(input: OrderCreateRequest, response: BackendCreateOrderResponse): Order {
  const order: Order = {
    id: response.orderId,
    kind: 'create',
    domainName: response.domainName,
    state: response.state,
    years: input.years,
    autoRenew: input.autoRenew,
    priceYen: response.priceYen,
  }
  if (response.state === 'done') {
    order.domain = {
      name: response.domainName,
      exDate: response.exDate ?? '',
      // spec §3.5: NS committed -> ok, none -> inactive (not公開 yet).
      statuses: response.nameservers.length > 0 ? ['ok'] : ['inactive'],
      // The backend never echoes authInfo; the form always sends one, so the
      // value the registry holds is the one from this request.
      authInfo: input.authInfo,
    }
  }
  return order
}

export async function createOrder(
  input: OrderCreateRequest | OrderRenewRequest,
  signal?: AbortSignal,
): Promise<Order> {
  if (input.kind === 'renew') {
    const response = await invoke<
      { domainName: string; periodYears: number; idempotencyKey: string },
      BackendRenewOrderResponse
    >(
      'renewOrder',
      { domainName: input.domainName, periodYears: input.years, idempotencyKey: idempotencyKeyFor(input) },
      { signal },
    )
    const order: Order = {
      id: response.orderId,
      kind: 'renew',
      domainName: response.domainName,
      state: response.state,
      years: input.years,
      // Renewal never touches the flag and the response does not carry it;
      // the screens that show it re-read the domain, so false is inert here.
      autoRenew: false,
      priceYen: response.priceYen,
    }
    if (response.state === 'done') {
      order.domain = {
        name: response.domainName,
        exDate: response.exDate ?? '',
        statuses: ['ok'],
        // Never echoed by the backend (renewal does not change it).
        authInfo: '',
      }
    }
    return order
  }

  const response = await invoke<Record<string, unknown>, BackendCreateOrderResponse>(
    'createOrder',
    {
      domainName: input.domainName,
      periodYears: input.years,
      nameservers: input.nameservers,
      idempotencyKey: idempotencyKeyFor(input),
      authInfo: input.authInfo,
      autoRenew: input.autoRenew,
      // contacts: every role is the member's per-registry contact (§5.1);
      // omitted so the backend applies its own member-contact defaults.
    },
    { signal },
  )

  return orderFromCreateResponse(input, response)
}

export function fetchOrder(orderId: string, signal?: AbortSignal): Promise<Order> {
  return invoke<{ orderId: string }, Order>('getOrder', { orderId }, { signal })
}
