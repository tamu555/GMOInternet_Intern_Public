/**
 * In-memory fake of the Firebase callable backend for vitest.
 *
 * The flow tests exercise the real UI through the real api/*.ts adapter
 * modules; only the `invoke()` seam (src/api/callable.ts) is replaced, so the
 * request/response mapping and ApiError handling in the adapters stay under
 * test. A test file opts in with:
 *
 *   vi.mock('../api/callable', async () => {
 *     const { fakeInvoke } = await import('../test/fakeBackend')
 *     return { invoke: fakeInvoke }
 *   })
 *
 * and calls `fakeBackend.reset()` in beforeEach. Failures are thrown as real
 * ApiError instances - exactly what invoke() would produce - so component
 * error paths behave identically.
 *
 * Default handlers replicate the seeds and state machines the retired MSW
 * domain/order handlers provided (src/mocks/handlers.ts + db.ts); the wire
 * shapes follow the callable contracts: real `searchDomains` / `listTlds` /
 * `createOrder` / `renewOrder` / `getOrder` / `listDomains` /
 * `getDomainInfo` / `updateDomain` / `updateAutoRenew` / `deleteDomain` /
 * `restoreDomain` / `rotateAuthInfo` / the DNS trio (`listDnsRecords` /
 * `saveDnsRecords` / `resolveDns`) / the five transfer callables
 * (`requestTransfer` / `cancelTransfer` / `respondTransfer` /
 * `listTransfers` / `getTransferStatus`) — all in functions/; nothing rides
 * functions-stubs/ any more. Auth + signup stay on MSW - they are out of
 * this fake's scope.
 */
import { ApiError } from '../api/apiError'
import { TLD_METADATA, getTldPricingOrDefault, registryForTld } from '../features/domains/tldData'

type Handler = (data: unknown) => unknown | Promise<unknown>

export type FakeSearchMode =
  | 'all-available'
  | 'all-taken'
  | 'partial-registry-timeout'
  /** kitaqnic judged unreachable — circuit open (docs/仕様/registry-unavailable.md). */
  | 'kitaqnic-unavailable'
  /** kitaqnic in a poll-announced maintenance window (registryMaintenance.ts). */
  | 'kitaqnic-maintenance'
  /** BOTH registries judged unreachable — both circuits open, still a 200. */
  | 'all-unavailable'
  /**
   * BOTH registries down before either circuit has opened: nothing answered
   * and nothing explained, so `searchDomains` rethrows and the call FAILS
   * (functions/src/api/searchDomains.ts "keep the error path"). This is the
   * outage shape the UI is most likely to meet first — the circuit needs ~1
   * minute of sustained 503s before the softer `all-unavailable` shape starts.
   */
  | 'all-registries-down'
  | 'server-error'
export type FakeTldsMode = 'ok' | 'server-error'
/** Same progression set the old OrderScenario offered (mocks/scenario.ts). */
export type FakeOrderOutcome =
  | 'success'
  | 'recovered-2302'
  | 'retry-then-success'
  | 'ns-update-failed'
  | 'retry-then-fail'
  | 'server-error'

type FakeDomain = {
  name: string
  registry: 'kitaqsign' | 'kitaqnic'
  statuses: string[]
  rgpStatuses: string[]
  exDate: string
  registeredAt: string
  autoRenew: boolean
  nameservers: string[]
  authInfo: string
  restorableUntil?: string
  autoRenewCancelableUntil?: string
}

/**
 * One `transfers/{uid}__{domainName}` record (functions/src/domain/transfers.ts).
 * Keyed by domain name, in both directions, exactly like the real backend.
 */
type FakeTransfer = {
  domainName: string
  registry: 'kitaqsign' | 'kitaqnic'
  direction: 'in' | 'out'
  state: 'pending' | 'completed' | 'rejected' | 'cancelled' | 'failed'
  requestedAt: string
  autoApproveAt: string | null
}

/** Kept self-contained like the rest of this file (no feature-module import). */
export type FakeDnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'

export type FakeDnsRecord = {
  type: FakeDnsRecordType
  /** Relative name: '@' for the apex, or a label like 'www'. */
  name: string
  value: string
  ttl?: number
  priority?: number
}

/**
 * One `watches/{uid}__{domainName}` record, single-member view
 * (functions/src/domain/watches.ts). The fake plays one signed-in member,
 * so the uid half of the key is implicit.
 */
export type FakeWatch = {
  domainName: string
  registry: 'kitaqsign' | 'kitaqnic'
  state: 'watching' | 'available' | 'fulfilled' | 'expired' | 'cancelled'
  createdAt: string
  expiresAt: string
  availableAt: string | null
}

export type FakeOrderRecord = {
  id: string
  kind: 'create' | 'renew'
  domainName: string
  years: number
  autoRenew: boolean
  priceYen: number
  authInfo: string
  idempotencyKey?: string
  renewBaseExDate?: string
  nameservers: string[]
  /** Captured at creation; a mode change mid-flight must not rewrite history. */
  outcome: Exclude<FakeOrderOutcome, 'server-error'>
  pollCount: number
  createdAt: string
}

// --- seeds (ported from src/mocks/db.ts, kept self-contained on purpose) ----

const DEFAULT_NAMESERVERS = ['ns1.teamc-dns.example', 'ns2.teamc-dns.example']

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function isoMinutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function seedDomains(): FakeDomain[] {
  return [
    {
      name: 'teamc-demo.com',
      registry: 'kitaqsign',
      statuses: ['ok'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(320),
      registeredAt: isoDaysFromNow(-45),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'K9#mQ2xTz8LpVr4N!bW7sD1e',
    },
    {
      name: 'teamc-portfolio.site',
      registry: 'kitaqnic',
      statuses: ['clientTransferProhibited', 'clientUpdateProhibited'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(210),
      registeredAt: isoDaysFromNow(-155),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Xp3!vLm9Qc6Rt2Zy8Ka5#dF1',
    },
    {
      name: 'teamc-shop.store',
      registry: 'kitaqnic',
      statuses: ['ok'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(24),
      registeredAt: isoDaysFromNow(-341),
      autoRenew: false,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Wq8*nB4Jt7Xe2Vs6Mh1$cR9y',
    },
    {
      name: 'teamc-easy.net',
      registry: 'kitaqsign',
      statuses: ['inactive'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(350),
      registeredAt: isoDaysFromNow(-15),
      autoRenew: true,
      nameservers: [],
      authInfo: 'Df5!kP1Yw9Sg3Nz7Lb2%vT6u',
    },
    {
      name: 'teamc-blog.online',
      registry: 'kitaqnic',
      statuses: ['ok'],
      rgpStatuses: ['autoRenewPeriod'],
      exDate: isoDaysFromNow(360),
      registeredAt: isoDaysFromNow(-370),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Gm2#hV7Rc4Tq9Xw1Zk6!pJ3s',
      autoRenewCancelableUntil: isoDaysFromNow(40),
    },
    {
      name: 'teamc-moving.xyz',
      registry: 'kitaqnic',
      statuses: ['pendingTransfer'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(110),
      registeredAt: isoDaysFromNow(-255),
      autoRenew: true,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Bt6!wN3Fh8Kd5Qy2Sv9*mX4z',
    },
    {
      name: 'teamc-old.icu',
      registry: 'kitaqnic',
      // RGP: delete puts the domain in pendingDelete *and* redemptionPeriod,
      // and only the latter is what makes 復旧 possible (45 days).
      statuses: ['pendingDelete'],
      rgpStatuses: ['redemptionPeriod'],
      exDate: isoDaysFromNow(-7),
      registeredAt: isoDaysFromNow(-372),
      autoRenew: false,
      nameservers: DEFAULT_NAMESERVERS,
      authInfo: 'Jr4$cZ8Vp1Ln6Ty3Wb7!qG2k',
      restorableUntil: isoDaysFromNow(23),
    },
  ]
}

/** FIG.3 下帯: registrar B is asking for the seeded pendingTransfer domain. */
function seedTransfers(): FakeTransfer[] {
  return [
    {
      domainName: 'teamc-moving.xyz',
      registry: 'kitaqnic',
      direction: 'out',
      state: 'pending',
      requestedAt: isoMinutesFromNow(-6),
      autoApproveAt: isoMinutesFromNow(14),
    },
  ]
}

// --- mutable state ----------------------------------------------------------

let domains: FakeDomain[] = seedDomains()
let transfers: FakeTransfer[] = seedTransfers()
let orders: FakeOrderRecord[] = []
/** Keyed by domain name; empty by default like the stub codebase's store. */
let dnsRecords: Record<string, FakeDnsRecord[]> = {}
let searchMode: FakeSearchMode = 'all-available'
/** Dev 503-injection flags (functions/src/api/devForceRegistry503.ts). */
let force503Flags = { kitaqsign: false, kitaqnic: false }
/** Dev maintenance windows (functions/src/api/devRegistryMaintenance.ts). */
let devMaintenanceActive = { kitaqsign: false, kitaqnic: false }
let tldsMode: FakeTldsMode = 'ok'
let orderOutcome: FakeOrderOutcome = 'success'
let watches: FakeWatch[] = []
const overrides = new Map<string, Handler>()
/** How often each callable was invoked since the last reset(). */
let callCounts: Record<string, number> = {}

// --- shared helpers (same rules as the retired MSW handlers) ----------------

const LOCK_STATUS_VALUES = [
  'clientTransferProhibited',
  'clientUpdateProhibited',
  'clientDeleteProhibited',
  'clientRenewProhibited',
] as const

const LOCK_STATUS_BY_KEY: Record<'transfer' | 'update' | 'delete' | 'renew', string> = {
  transfer: 'clientTransferProhibited',
  update: 'clientUpdateProhibited',
  delete: 'clientDeleteProhibited',
  renew: 'clientRenewProhibited',
}

/** §3.5: `ok` is exclusive; base state from the nameservers, locks stack on top. */
function recomputeStatuses(nameservers: string[], lockStatuses: string[]): string[] {
  const statuses = [...(nameservers.length === 0 ? ['inactive'] : []), ...lockStatuses]
  return statuses.length > 0 ? statuses : ['ok']
}

function lockStatusesOf(domain: FakeDomain): string[] {
  return domain.statuses.filter((status) => (LOCK_STATUS_VALUES as readonly string[]).includes(status))
}

function isLifecycleLocked(domain: FakeDomain): boolean {
  return domain.statuses.includes('pendingDelete') || domain.statuses.includes('pendingTransfer')
}

function findDomain(name: string): FakeDomain | undefined {
  return domains.find((domain) => domain.name === name)
}

function upsertDomain(domain: FakeDomain): FakeDomain {
  const exists = domains.some((existing) => existing.name === domain.name)
  domains = exists
    ? domains.map((existing) => (existing.name === domain.name ? domain : existing))
    : [...domains, domain]
  return domain
}

function serverError(): ApiError {
  return new ApiError({ kind: 'server', status: 500, code: 'functions/internal' })
}

function notFound(): ApiError {
  return new ApiError({
    kind: 'notFound',
    status: 404,
    message: '対象が見つかりませんでした。',
    code: 'functions/not-found',
  })
}

/**
 * What `invoke()` builds from the backend's "could not reach the registry"
 * answer: HttpsError `unavailable` WITHOUT the `registry-unavailable` marker
 * (httpsErrors.ts attaches that only once the circuit is open), so
 * callable.ts's CODE_MAP lands on kind 'network' and keeps the server's own
 * Japanese sentence.
 */
function registryUnreachable(): ApiError {
  return new ApiError({
    kind: 'network',
    status: 0,
    message: 'レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。',
    code: 'functions/unavailable',
  })
}

/** permission-denied: the ownership gate refused (functions/ ownership.ts). */
function permissionDenied(): ApiError {
  return new ApiError({
    kind: 'forbidden',
    status: 403,
    message: '対象のドメインが見つからないか、このアカウントの所有物ではありません。',
    code: 'functions/permission-denied',
  })
}

/** failed-precondition (2306 相当 §6.7) maps to validation/400 in callable.ts. */
function policyViolation(): ApiError {
  return new ApiError({
    kind: 'validation',
    status: 400,
    message: 'この操作は現在の状態では行えません。',
    code: 'functions/failed-precondition',
  })
}

// --- transfers (§6.6): same record shape and vocabulary as functions/ -------

/** §6.6.1: the pseudo-registries auto-approve 20 minutes after the request. */
const AUTO_APPROVE_MS = 20 * 60 * 1000

/** Japanese one-liners transferDomain.ts attaches when no command just ran. */
const TRANSFER_STATE_MESSAGES: Record<FakeTransfer['state'], string> = {
  pending: '移管の手続き中です。',
  completed: '移管が完了しました。',
  rejected: '移管は拒否されました。',
  cancelled: '移管申請は取り消されました。',
  failed: '移管処理は完了しませんでした。',
}

const PENDING_IN_MESSAGE = '移管を申請しました。移管元レジストラの承認をお待ちください。'
const PENDING_OUT_MESSAGE = '移管申請が届いています。承認または拒否してください。'

function findTransfer(domainName: string): FakeTransfer | undefined {
  return transfers.find((transfer) => transfer.domainName === domainName)
}

function upsertTransfer(transfer: FakeTransfer): FakeTransfer {
  const exists = transfers.some((existing) => existing.domainName === transfer.domainName)
  transfers = exists
    ? transfers.map((existing) =>
        existing.domainName === transfer.domainName ? transfer : existing,
      )
    : [...transfers, transfer]
  return transfer
}

/** Serializes to the backend's TransferResult (transferDomain.ts toResult). */
function transferResult(transfer: FakeTransfer, message?: string) {
  const pendingMessage = transfer.direction === 'out' ? PENDING_OUT_MESSAGE : PENDING_IN_MESSAGE
  return {
    domainName: transfer.domainName,
    registry: transfer.registry,
    direction: transfer.direction,
    state: transfer.state,
    gainingRegistrar: null,
    losingRegistrar: null,
    requestedAt: transfer.requestedAt,
    autoApproveAt: transfer.autoApproveAt,
    recovered: false,
    message:
      message ??
      (transfer.state === 'pending' ? pendingMessage : TRANSFER_STATE_MESSAGES[transfer.state]),
  }
}

// --- orders: the poll-driven state machine (ported from mocks/db.ts) --------

const PROVISIONING_POLLS = 2
const RETRYING_POLLS = 3

function orderStateFor(order: FakeOrderRecord): 'provisioning' | 'retrying' | 'done' | 'failed' {
  const { outcome, pollCount } = order
  if (pollCount <= PROVISIONING_POLLS) return 'provisioning'
  if (outcome === 'retry-then-success' || outcome === 'retry-then-fail') {
    if (pollCount <= PROVISIONING_POLLS + RETRYING_POLLS) return 'retrying'
    return outcome === 'retry-then-success' ? 'done' : 'failed'
  }
  return 'done'
}

function orderExDate(order: FakeOrderRecord): string {
  const base = new Date(order.kind === 'renew' ? (order.renewBaseExDate ?? order.createdAt) : order.createdAt)
  base.setFullYear(base.getFullYear() + order.years)
  return base.toISOString()
}

/** FIG.9: a completed order surfaces in the owned-domain list (idempotent). */
function applyOrderCompletion(order: FakeOrderRecord): void {
  if (order.kind === 'renew') {
    const domain = findDomain(order.domainName)
    if (!domain) return
    const iso = orderExDate(order)
    if (domain.exDate !== iso) upsertDomain({ ...domain, exDate: iso })
    return
  }
  if (findDomain(order.domainName)) return
  const tld = order.domainName.slice(order.domainName.indexOf('.'))
  upsertDomain({
    name: order.domainName,
    registry: registryForTld(tld) ?? 'kitaqsign',
    statuses: recomputeStatuses(nameserversOf(order), []),
    rgpStatuses: [],
    exDate: orderExDate(order),
    registeredAt: order.createdAt,
    autoRenew: order.autoRenew,
    nameservers: nameserversOf(order),
    authInfo: order.authInfo,
  })
}

/**
 * Nameservers the (fake) registry ends up holding. `domain:create` carries
 * none, so this is what the following `domain:update` managed to attach:
 * nothing at all when the order asked for nothing, and nothing when the
 * update was refused ('ns-update-failed'). Either way the domain is
 * registered and the order is done - only the delegation is missing.
 */
function nameserversOf(order: FakeOrderRecord): string[] {
  return order.outcome === 'ns-update-failed' ? [] : order.nameservers
}

/** Serializes to the FE Order shape (the stub getOrder contract). */
function serializeOrder(order: FakeOrderRecord, state: 'paid' | 'provisioning' | 'retrying' | 'done' | 'failed') {
  const base = {
    id: order.id,
    kind: order.kind,
    domainName: order.domainName,
    state,
    years: order.years,
    autoRenew: order.autoRenew,
    priceYen: order.priceYen,
  }
  if (state !== 'done') return base
  return {
    ...base,
    domain: {
      name: order.domainName,
      exDate: orderExDate(order),
      statuses: recomputeStatuses(nameserversOf(order), []),
      authInfo: order.authInfo,
    },
  }
}

// --- default handlers -------------------------------------------------------

/** Fixed announced end for 'kitaqnic-maintenance', so tests can assert on it. */
export const FAKE_MAINTENANCE_UNTIL = '2026-08-30T03:00:00.000Z'

/** Fixed auto-off time for active dev 503 flags, so tests can assert on it. */
export const FAKE_FORCE_503_EXPIRES_AT = '2026-08-30T04:00:00.000Z'

const DEFAULT_HANDLERS: Record<string, Handler> = {
  /** Real-callable wire: {names} -> {results, unsupported, unavailable} (functions/). */
  searchDomains: (data) => {
    if (searchMode === 'server-error') throw serverError()
    if (searchMode === 'all-registries-down') throw registryUnreachable()
    const { names } = data as { names: string[] }
    const results: Array<{ name: string; registry: 'kitaqsign' | 'kitaqnic'; available: boolean; reason?: string }> = []
    const unsupported: string[] = []
    const unavailable: string[] = []
    const maintenance: string[] = []
    for (const raw of names) {
      const name = raw.toLowerCase()
      const tld = name.slice(name.indexOf('.'))
      const registry = registryForTld(tld)
      if (!registry) {
        unsupported.push(name)
        continue
      }
      if (searchMode === 'all-taken') {
        results.push({ name, registry, available: false, reason: '2302' })
        continue
      }
      if (
        searchMode === 'all-unavailable' ||
        (searchMode === 'kitaqnic-unavailable' && registry === 'kitaqnic')
      ) {
        unavailable.push(name)
        continue
      }
      if (searchMode === 'kitaqnic-maintenance' && registry === 'kitaqnic') {
        maintenance.push(name)
        continue
      }
      if (searchMode === 'partial-registry-timeout' && registry === 'kitaqnic') {
        // The timed-out registry never answers: the name appears in neither
        // list, which the adapter must fold into the honest third state.
        continue
      }
      results.push({ name, registry, available: true })
    }
    return {
      results,
      unsupported,
      unavailable,
      maintenance,
      maintenanceUntil: maintenance.length > 0 ? FAKE_MAINTENANCE_UNTIL : null,
    }
  },

  /** Dev 503-injection lever (functions/src/api/devForceRegistry503.ts). */
  devForceRegistry503: (data) => {
    const request = data as {
      action?: string
      registry?: 'kitaqsign' | 'kitaqnic'
      enabled?: boolean
    }
    if (request.action === 'set' && request.registry) {
      force503Flags = { ...force503Flags, [request.registry]: request.enabled === true }
    }
    return {
      flags: { ...force503Flags },
      expiresAt: {
        kitaqsign: force503Flags.kitaqsign ? FAKE_FORCE_503_EXPIRES_AT : null,
        kitaqnic: force503Flags.kitaqnic ? FAKE_FORCE_503_EXPIRES_AT : null,
      },
      health: { kitaqsign: 'ok', kitaqnic: 'ok' },
    }
  },

  /** Dev maintenance-window lever (functions/src/api/devRegistryMaintenance.ts). */
  devRegistryMaintenance: (data) => {
    const request = data as {
      action?: string
      registry?: 'kitaqsign' | 'kitaqnic'
      durationMinutes?: number
    }
    if (request.registry && (request.action === 'set' || request.action === 'clear')) {
      devMaintenanceActive = {
        ...devMaintenanceActive,
        [request.registry]: request.action === 'set',
      }
    }
    const summary = (registry: 'kitaqsign' | 'kitaqnic') =>
      devMaintenanceActive[registry]
        ? {
            active: true,
            windowStart: null,
            windowEnd: FAKE_MAINTENANCE_UNTIL,
            msgType: 'dev:maintenance',
            note: 'モックAPI設定パネルからの検証用メンテナンス窓',
          }
        : { active: false, windowStart: null, windowEnd: null, msgType: null, note: null }
    return {
      maintenance: { kitaqsign: summary('kitaqsign'), kitaqnic: summary('kitaqnic') },
    }
  },

  /** Real-callable wire: {} -> {tlds} (functions/src/api/listTlds.ts). */
  listTlds: () => {
    if (tldsMode === 'server-error') throw serverError()
    return { tlds: TLD_METADATA.map((meta) => meta.tld) }
  },

  /** Real-callable wire (functions/src/api/createOrder.ts). */
  createOrder: (data) => {
    if (orderOutcome === 'server-error') throw serverError()
    const body = data as {
      domainName: string
      periodYears?: number
      nameservers?: string[]
      idempotencyKey: string
      authInfo?: string
      autoRenew?: boolean
    }
    const existing = orders.find((order) => order.idempotencyKey === body.idempotencyKey)
    if (existing) {
      return {
        orderId: existing.id,
        orderSeq: Number(existing.id.slice('ord-'.length)),
        priceYen: existing.priceYen,
        state: 'paid',
        domainName: existing.domainName,
        registry: registryForTld(existing.domainName.slice(existing.domainName.indexOf('.'))) ?? 'kitaqsign',
        nameservers: existing.nameservers,
        recovered: true,
        message: '',
      }
    }
    const tld = body.domainName.slice(body.domainName.indexOf('.'))
    // Mirrors the real backend: only a TLD no registry serves is rejected
    // (functions/src/api/createOrder.ts routes via the hello map); a served
    // but unpriced TLD is charged pricing.ts's DEFAULT_PRICE instead.
    if (!registryForTld(tld)) {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: '取り扱いのないドメインです。',
        code: 'functions/invalid-argument',
      })
    }
    const pricing = getTldPricingOrDefault(tld)
    const years = body.periodYears ?? 1
    const order: FakeOrderRecord = {
      id: `ord-${String(orders.length + 1).padStart(6, '0')}`,
      kind: 'create',
      domainName: body.domainName,
      years,
      autoRenew: body.autoRenew ?? true,
      priceYen: pricing.firstYearYen + pricing.renewalYearYen * (years - 1),
      authInfo: body.authInfo ?? '',
      idempotencyKey: body.idempotencyKey,
      nameservers: body.nameservers ?? [],
      outcome: orderOutcome,
      pollCount: 0,
      createdAt: new Date().toISOString(),
    }
    orders = [...orders, order]
    return {
      orderId: order.id,
      orderSeq: orders.length,
      priceYen: order.priceYen,
      state: 'paid',
      domainName: order.domainName,
      registry: registryForTld(tld) ?? 'kitaqsign',
      nameservers: order.nameservers,
      recovered: false,
      message: '',
    }
  },

  /**
   * Real-callable wire (functions/src/api/getOrder.ts): {orderId} -> Order.
   * The poll-count progression stands in for the real backend's
   * resume-on-poll provisioning (each poll advances a non-terminal order).
   */
  getOrder: (data) => {
    const { orderId } = data as { orderId: string }
    const order = orders.find((existing) => existing.id === orderId)
    if (!order) throw notFound()
    order.pollCount += 1
    const state = orderStateFor(order)
    if (state === 'done') applyOrderCompletion(order)
    return serializeOrder(order, state)
  },

  /** Real-callable wire (functions/src/api/renewOrder.ts). */
  renewOrder: (data) => {
    if (orderOutcome === 'server-error') throw serverError()
    const body = data as { domainName: string; periodYears: number; idempotencyKey?: string }
    if (!body.idempotencyKey) {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'idempotencyKey は必須です。',
        code: 'functions/invalid-argument',
      })
    }
    const existing = orders.find((order) => order.idempotencyKey === body.idempotencyKey)
    if (existing && existing.kind !== 'renew') {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'この idempotencyKey は create 用に使用済みです。',
        code: 'functions/invalid-argument',
      })
    }
    const domain = findDomain(body.domainName)
    if (!domain) throw notFound()
    if (isLifecycleLocked(domain)) throw policyViolation()
    if (domain.statuses.includes(LOCK_STATUS_BY_KEY.renew)) throw policyViolation()
    const renewWire = (order: FakeOrderRecord, recovered: boolean) => ({
      orderId: order.id,
      orderSeq: Number(order.id.slice('ord-'.length)),
      priceYen: order.priceYen,
      state: 'paid',
      domainName: order.domainName,
      registry: domain.registry,
      recovered,
      message: '',
    })
    if (existing) return renewWire(existing, true)
    const tld = body.domainName.slice(body.domainName.indexOf('.'))
    // Owned domains renew at the table price, or the server default for a
    // TLD outside the table (functions/src/domain/pricing.ts DEFAULT_PRICE).
    const pricing = getTldPricingOrDefault(tld)
    const order: FakeOrderRecord = {
      id: `ord-${String(orders.length + 1).padStart(6, '0')}`,
      kind: 'renew',
      domainName: body.domainName,
      years: body.periodYears,
      autoRenew: domain.autoRenew,
      priceYen: pricing.renewalYearYen * body.periodYears,
      authInfo: domain.authInfo,
      idempotencyKey: body.idempotencyKey,
      renewBaseExDate: domain.exDate,
      nameservers: domain.nameservers,
      // Narrowed by the early server-error throw above.
      outcome: orderOutcome,
      pollCount: 0,
      createdAt: new Date().toISOString(),
    }
    orders = [...orders, order]
    return renewWire(order, false)
  },

  // --- my-page: real list/detail/update wires (functions/) ------------------

  /** Real-callable wire (functions/src/domain/domainRepository.ts). */
  listDomains: () => ({
    domains: domains.map((domain) => ({
      name: domain.name,
      tld: domain.name.slice(domain.name.indexOf('.')),
      registry: domain.registry,
      status: domain.statuses,
      rgpStatus: domain.rgpStatuses,
      exDate: domain.exDate,
      autoRenew: domain.autoRenew,
      // Server-derived: null unless the domain is in redemptionPeriod, the
      // same rule domainRepository.ts applies.
      restorableUntil: domain.rgpStatuses.includes('redemptionPeriod')
        ? (domain.restorableUntil ?? null)
        : null,
      // Server-derived too: non-null only while autoRenewPeriod is on
      // (domainRepository.ts's autoRenewCancelableUntilFromMirror).
      autoRenewCancelableUntil: domain.rgpStatuses.includes('autoRenewPeriod')
        ? (domain.autoRenewCancelableUntil ?? null)
        : null,
      restoreFeeYen: domain.registry === 'kitaqsign' ? 8000 : 6000,
    })),
  }),

  /** Real-callable wire (functions/src/domain/getDomainInfo.ts). */
  getDomainInfo: (data) => {
    const { domainName } = data as { domainName: string }
    const domain = findDomain(domainName)
    if (!domain) throw notFound()
    return {
      domain: domain.name,
      registry: domain.registry,
      status: domain.statuses,
      registrant: 'U000001',
      contacts: { admin: 'U000001', tech: 'U000001', billing: 'U000001' },
      nameservers: domain.nameservers,
      crDate: domain.registeredAt,
      upDate: null,
      exDate: domain.exDate,
      trDate: null,
      rgpStatus: domain.rgpStatuses,
    }
  },

  /** Real-callable wire (functions/src/api/updateDomain.ts, delta-based). */
  updateDomain: (data) => {
    const body = data as {
      operationId?: string
      domainName: string
      add?: { nameservers?: string[]; statuses?: string[] }
      remove?: { nameservers?: string[]; statuses?: string[] }
    }
    if (!body.operationId) {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'operationId は1〜128文字である必要があります。',
        code: 'functions/invalid-argument',
      })
    }
    const domain = findDomain(body.domainName)
    if (!domain) throw notFound()
    if (isLifecycleLocked(domain)) throw policyViolation()
    const touchesNs = Boolean(body.add?.nameservers || body.remove?.nameservers)
    const unlocksUpdate = body.remove?.statuses?.includes(LOCK_STATUS_BY_KEY.update) ?? false
    if (touchesNs && domain.statuses.includes(LOCK_STATUS_BY_KEY.update) && !unlocksUpdate) {
      throw policyViolation()
    }
    const nsSet = new Set(domain.nameservers)
    for (const host of body.add?.nameservers ?? []) nsSet.add(host)
    for (const host of body.remove?.nameservers ?? []) nsSet.delete(host)
    const nameservers = [...nsSet]
    let lockStatuses = lockStatusesOf(domain)
    for (const status of body.add?.statuses ?? []) {
      lockStatuses = [...new Set([...lockStatuses, status])]
    }
    for (const status of body.remove?.statuses ?? []) {
      lockStatuses = lockStatuses.filter((existing) => existing !== status)
    }
    const changed =
      nameservers.length !== domain.nameservers.length ||
      nameservers.some((host) => !domain.nameservers.includes(host)) ||
      lockStatuses.length !== lockStatusesOf(domain).length ||
      lockStatuses.some((status) => !domain.statuses.includes(status))
    if (!changed) {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: '現在のレジストリの状態と比較して変更内容がありません。',
        code: 'functions/failed-precondition',
      })
    }
    upsertDomain({
      ...domain,
      nameservers,
      statuses: recomputeStatuses(nameservers, lockStatuses),
    })
    return {
      operationId: body.operationId,
      resourceName: domain.name,
      state: 'ready',
      recovered: false,
    }
  },

  /** Real-callable wire (functions/src/api/updateAutoRenew.ts): mirror flag. */
  updateAutoRenew: (data) => {
    const { domainName, autoRenew } = data as { domainName: string; autoRenew: boolean }
    const domain = findDomain(domainName)
    if (!domain) throw notFound()
    // pendingDelete is refused server-side (failed-precondition), matching
    // the disabled switch in the UI.
    if (domain.statuses.includes('pendingDelete')) throw policyViolation()
    const updated = upsertDomain({ ...domain, autoRenew })
    return { domainName: updated.name, autoRenew: updated.autoRenew }
  },

  // --- AuthCode 再生成: the real callable (functions/, §3.9) ----------------

  /**
   * Real-callable wire (functions/src/domain/rotateAuthInfo.ts
   * AuthInfoRotationResult). The registry mints the value; the backend keeps
   * no copy, so this fake mints one and does NOT write it back into the fake
   * domain either - a test that expected to read it back would be testing a
   * behaviour the real service does not have. A domain that is not the
   * caller's answers permission-denied (ownership.ts's uniform failure), not
   * not-found: the ownership gate is what refuses, before the registry.
   */
  rotateAuthInfo: (data) => {
    const { domainName } = data as { domainName: string }
    const domain = findDomain(domainName)
    if (!domain) throw permissionDenied()
    const authInfo = `Fk${Math.random().toString(36).slice(2, 12)}!${Math.random().toString(36).slice(2, 12)}Z9`
    return {
      domainName: domain.name,
      registry: domain.registry,
      authInfo,
      rotatedAt: new Date().toISOString(),
      message: '認証コード（AuthCode）を再生成しました。以前のコードは使えません。',
    }
  },

  // --- transfers: the five real callables (functions/, §6.6) ----------------

  /**
   * Real-callable wire (functions/src/api/transferCallables.ts): keyed by
   * domainName, answers a TransferResult. Failure branches mirror
   * transferDomain.ts's own wording and httpsErrors.ts's code mapping; the
   * magic domain markers ('not-found' / 'wrong-auth') stand in for the
   * registry answers 2303 / 2202. Settlement is driven by the losing side, so
   * tests play registrar B with fakeBackend.settleTransferIn().
   */
  requestTransfer: (data) => {
    const body = data as { domainName: string; authInfo: string }
    const domainName = body.domainName.toLowerCase()
    const tld = domainName.slice(domainName.indexOf('.'))
    const registry = registryForTld(tld)
    if (!domainName.includes('.') || !registry) {
      // ValidationError('domainName', ...) -> invalid-argument + details.field.
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'このドメインのTLDは当サービスでは取り扱っていません。',
        code: 'functions/invalid-argument',
        fieldErrors: { domainName: 'このドメインのTLDは当サービスでは取り扱っていません。' },
      })
    }
    if (findDomain(domainName)) {
      // TransferError('alreadyOurs') -> failed-precondition.
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'このドメインはすでにお客様が当サービスで管理しています。',
        code: 'functions/failed-precondition',
      })
    }
    const existing = findTransfer(domainName)
    // A re-submitted form answers with the request already in flight.
    if (existing && existing.state === 'pending') return transferResult(existing)
    if (domainName.includes('not-found')) {
      // objectNotFound on `request` -> TransferError('refused').
      throw new ApiError({
        kind: 'forbidden',
        status: 403,
        message: 'そのドメインはレジストリに登録されていません。ドメイン名をご確認ください。',
        code: 'functions/permission-denied',
      })
    }
    if (domainName.includes('wrong-auth')) {
      // EPP 2202 / HTTP 401 -> invalid-argument + details.field = 'authInfo'.
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message:
          '認証コード（AuthCode）が違うようです。移管元の管理画面でもう一度ご確認ください。',
        code: 'functions/invalid-argument',
        fieldErrors: {
          authInfo: '認証コード（AuthCode）が違うようです。移管元の管理画面でもう一度ご確認ください。',
        },
      })
    }
    const requestedAt = new Date().toISOString()
    return transferResult(
      upsertTransfer({
        domainName,
        registry,
        direction: 'in',
        state: 'pending',
        requestedAt,
        autoApproveAt: new Date(Date.parse(requestedAt) + AUTO_APPROVE_MS).toISOString(),
      }),
    )
  },

  /** 移管IN の取消 (§6.6.1): only a pending inbound request can be withdrawn. */
  cancelTransfer: (data) => {
    const { domainName } = data as { domainName: string }
    const transfer = findTransfer(domainName)
    if (!transfer || transfer.direction !== 'in' || transfer.state !== 'pending') {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: '取り消せる移管申請が見つかりませんでした。',
        code: 'functions/failed-precondition',
      })
    }
    return transferResult(upsertTransfer({ ...transfer, state: 'cancelled' }), '移管申請を取り消しました。')
  },

  /** 移管OUT の承認 / 拒否 (FIG.3 下帯). */
  respondTransfer: (data) => {
    const { domainName, action } = data as { domainName: string; action: 'approve' | 'reject' }
    const domain = findDomain(domainName)
    if (!domain) throw notFound()
    const transfer = findTransfer(domainName)
    if (!transfer || transfer.direction !== 'out' || transfer.state !== 'pending') {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: '対象の移管申請が見つかりませんでした。',
        code: 'functions/failed-precondition',
      })
    }
    if (action === 'approve') {
      // 承認 = the domain now belongs to the gaining registrar (mirror `gone`).
      domains = domains.filter((existing) => existing.name !== domainName)
    } else {
      upsertDomain({
        ...domain,
        statuses: recomputeStatuses(domain.nameservers, lockStatusesOf(domain)),
      })
    }
    return transferResult(
      upsertTransfer({ ...transfer, state: action === 'approve' ? 'completed' : 'rejected' }),
      action === 'approve'
        ? '移管を承認しました。このドメインは移管先レジストラの管理になります。'
        : '移管申請を拒否しました。ドメインは引き続きご利用いただけます。',
    )
  },

  /** ⚠️ PENDING only, both directions — same as listPendingTransfers(). */
  listTransfers: () => ({
    transfers: transfers
      .filter((transfer) => transfer.state === 'pending')
      .map((transfer) => transferResult(transfer)),
  }),

  /**
   * Real callable is the emulator-only stand-in for the scheduled pollWorker
   * (functions/src/api/drainPollQueue.ts). The fake has no queue to drain —
   * `upsertTransfer()` already lands requests straight in the in-memory
   * store — so this is a no-op that answers with the real wire shape.
   */
  drainPollQueue: () => ({ results: [], reconcile: {} }),

  getTransferStatus: (data) => {
    const { domainName } = data as { domainName: string }
    const transfer = findTransfer(domainName)
    if (!transfer) {
      throw new ApiError({
        kind: 'notFound',
        status: 404,
        message: '対象の移管が見つかりません。',
        code: 'functions/not-found',
      })
    }
    return transferResult(transfer)
  },

  // --- DNS records (real wire, functions/src/api/dnsRecords.ts) -------------

  /** Stub wire: {domainName} -> {records}; unknown domains answer empty. */
  listDnsRecords: (data) => {
    const { domainName } = data as { domainName: string }
    return { records: dnsRecords[domainName] ?? [] }
  },

  /** Stub wire: full-replacement save; name '' normalizes to '@' (index.ts). */
  saveDnsRecords: (data) => {
    const { domainName, records } = data as { domainName: string; records: FakeDnsRecord[] }
    const normalized = records.map((record) => ({
      ...record,
      name: record.name === '' ? '@' : record.name,
    }))
    dnsRecords = { ...dnsRecords, [domainName]: normalized }
    return { records: normalized }
  },

  /**
   * Stub wire: resolves a FQDN against the saved store the way the mini
   * resolver (§6.3.2 Lv2) would - '@'/'' is the apex, any other name is a
   * label under the domain. No match is an EMPTY answer, never an error
   * (the confirm button turns it into「反映待ち」).
   */
  resolveDns: (data) => {
    const { name, type } = data as { name: string; type: FakeDnsRecordType }
    const wanted = name.toLowerCase().replace(/\.$/, '')
    const matches: FakeDnsRecord[] = []
    for (const domainName of Object.keys(dnsRecords)) {
      for (const record of dnsRecords[domainName]) {
        const fqdn =
          record.name === '@' || record.name === '' ? domainName : `${record.name}.${domainName}`
        if (fqdn.toLowerCase() === wanted && record.type === type) matches.push(record)
      }
    }
    return { records: matches }
  },

  // --- real lifecycle callables (functions/ LifecycleResult wire) -----------

  deleteDomain: (data) => {
    const { domainName } = data as { domainName: string }
    const domain = findDomain(domainName)
    if (!domain) throw notFound()
    if (isLifecycleLocked(domain)) throw policyViolation()
    if (domain.statuses.includes(LOCK_STATUS_BY_KEY.delete)) throw policyViolation()
    // 45 days = grace-period-days, documented by both registries.
    const restorableUntil = isoDaysFromNow(45)
    upsertDomain({
      ...domain,
      statuses: ['pendingDelete'],
      autoRenew: false,
      rgpStatuses: ['redemptionPeriod'],
      autoRenewCancelableUntil: undefined,
      restorableUntil,
    })
    return {
      domainName: domain.name,
      registry: domain.registry,
      lifecycle: 'pendingDelete',
      status: ['pendingDelete'],
      rgpStatus: ['redemptionPeriod'],
      exDate: domain.exDate,
      alreadyInState: false,
      restoreFeeYen: domain.registry === 'kitaqsign' ? 8000 : 6000,
      message: '廃止を受け付けました。猶予期間内は復旧できます。',
    }
  },

  restoreDomain: (data) => {
    const { domainName } = data as { domainName: string }
    const domain = findDomain(domainName)
    if (!domain) throw notFound()
    // The registry refuses (2304) outside redemptionPeriod, which is a
    // shorter window than pendingDelete: the last five days of pendingDelete
    // are not restorable.
    if (!domain.rgpStatuses.includes('redemptionPeriod')) throw policyViolation()
    const expired = new Date(domain.exDate).getTime() < Date.now()
    const exDate = expired ? isoDaysFromNow(365) : domain.exDate
    const restored = upsertDomain({
      ...domain,
      statuses: recomputeStatuses(domain.nameservers, []),
      rgpStatuses: [],
      exDate,
      restorableUntil: undefined,
    })
    return {
      domainName: restored.name,
      registry: restored.registry,
      lifecycle: 'active',
      status: restored.statuses,
      rgpStatus: restored.rgpStatuses,
      exDate: restored.exDate,
      alreadyInState: false,
      message: '復旧しました。',
    }
  },

  // --- 空き待ち通知 (real wire, functions/src/api/watchCallables.ts) --------

  /** Real wire: {domainName} -> {watch, alreadyWatching}; idempotent. */
  addWatch: (data) => {
    const { domainName } = data as { domainName: string }
    const name = domainName.toLowerCase()
    const registry = registryForTld(name.slice(name.indexOf('.')))
    if (!registry) {
      throw new ApiError({
        kind: 'validation',
        status: 400,
        message: 'このTLDは取り扱っていません。',
        code: 'functions/invalid-argument',
      })
    }
    const existing = watches.find((watch) => watch.domainName === name)
    if (existing && (existing.state === 'watching' || existing.state === 'available')) {
      return { watch: { ...existing }, alreadyWatching: true }
    }
    const watch: FakeWatch = {
      domainName: name,
      registry,
      state: 'watching',
      createdAt: new Date().toISOString(),
      expiresAt: isoDaysFromNow(30),
      availableAt: null,
    }
    watches = [...watches.filter((entry) => entry.domainName !== name), watch]
    return { watch: { ...watch }, alreadyWatching: false }
  },

  /** Real wire: {} -> {watches}, cancelled omitted, newest first. */
  listWatches: () => ({
    watches: watches
      .filter((watch) => watch.state !== 'cancelled')
      .slice()
      .reverse()
      .map((watch) => ({ ...watch })),
  }),

  /** Real wire: {domainName} -> {ok}; not-found without a watch. */
  cancelWatch: (data) => {
    const { domainName } = data as { domainName: string }
    const name = domainName.toLowerCase()
    const existing = watches.find((watch) => watch.domainName === name)
    if (!existing) {
      throw new ApiError({
        kind: 'notFound',
        status: 404,
        message: 'このドメインの空き待ちは登録されていません。',
        code: 'functions/not-found',
      })
    }
    watches = watches.map((watch) =>
      watch.domainName === name ? { ...watch, state: 'cancelled' } : watch,
    )
    return { ok: true }
  },
}

// --- public surface ---------------------------------------------------------

export const fakeBackend = {
  /** Per-test override for one callable; cleared by reset(). */
  on(name: string, impl: Handler): void {
    overrides.set(name, impl)
  },
  /** Reseeds every store and clears overrides + modes. Call in beforeEach. */
  reset(): void {
    overrides.clear()
    domains = seedDomains()
    transfers = seedTransfers()
    orders = []
    dnsRecords = {}
    searchMode = 'all-available'
    tldsMode = 'ok'
    orderOutcome = 'success'
    force503Flags = { kitaqsign: false, kitaqnic: false }
    devMaintenanceActive = { kitaqsign: false, kitaqnic: false }
    watches = []
    callCounts = {}
  },
  setSearchMode(mode: FakeSearchMode): void {
    searchMode = mode
  },
  /**
   * How many times a callable was invoked since reset(). Lets a test assert
   * that an action really reached the backend - "the button re-ran the
   * search" cannot be told from "the old results are still on screen" by
   * looking at the DOM alone.
   */
  callCount(name: string): number {
    return callCounts[name] ?? 0
  },
  /** Current dev 503-injection flags, for panel assertions. */
  force503(): { kitaqsign: boolean; kitaqnic: boolean } {
    return { ...force503Flags }
  },
  /** Which registries have an active dev maintenance window, for panel assertions. */
  devMaintenance(): { kitaqsign: boolean; kitaqnic: boolean } {
    return { ...devMaintenanceActive }
  },
  setTldsMode(mode: FakeTldsMode): void {
    tldsMode = mode
  },
  /** Applies to orders created AFTER the call (mirrors the old scenario panel). */
  setOrderOutcome(outcome: FakeOrderOutcome): void {
    orderOutcome = outcome
  },
  orders(): readonly FakeOrderRecord[] {
    return orders
  },
  domains(): readonly FakeDomain[] {
    return domains
  },
  transfers(): readonly FakeTransfer[] {
    return transfers
  },
  /** 移管IN のうち、まだ相手待ちのもの (what listTransfers would answer with). */
  pendingTransferIns(): readonly FakeTransfer[] {
    return transfers.filter(
      (transfer) => transfer.direction === 'in' && transfer.state === 'pending',
    )
  },
  /**
   * Plays losing-registrar B — the half of §6.6.1 that happens outside this
   * app (an approve/reject from the other account, or the 20-minute
   * auto-approve). The record leaves the pending list either way; `completed`
   * additionally imports the domain, which is what the real poll worker does.
   */
  settleTransferIn(domainName: string, outcome: 'completed' | 'rejected'): void {
    const transfer = findTransfer(domainName)
    if (!transfer || transfer.direction !== 'in' || transfer.state !== 'pending') {
      throw new Error(`no pending transfer-in for "${domainName}" to settle`)
    }
    upsertTransfer({ ...transfer, state: outcome })
    if (outcome === 'rejected') return
    upsertDomain({
      name: transfer.domainName,
      registry: transfer.registry,
      statuses: ['ok'],
      rgpStatuses: [],
      exDate: isoDaysFromNow(365),
      registeredAt: new Date().toISOString(),
      autoRenew: true,
      nameservers: ['ns1.previous-registrar.example', 'ns2.previous-registrar.example'],
      authInfo: 'Tn7!settled-by-fake-B#2026',
    })
  },
  dnsRecords(): Readonly<Record<string, readonly FakeDnsRecord[]>> {
    return dnsRecords
  },
  watches(): readonly FakeWatch[] {
    return watches
  },
  /** Seeds one watch, as if the member had registered it earlier. */
  seedWatch(domainName: string, state: FakeWatch['state'] = 'watching'): void {
    const name = domainName.toLowerCase()
    const registry = registryForTld(name.slice(name.indexOf('.')))
    if (!registry) throw new Error(`seedWatch: unsupported TLD in "${domainName}"`)
    watches = [
      ...watches.filter((entry) => entry.domainName !== name),
      {
        domainName: name,
        registry,
        state,
        createdAt: new Date().toISOString(),
        expiresAt: isoDaysFromNow(30),
        availableAt: state === 'available' ? new Date().toISOString() : null,
      },
    ]
  },
  /**
   * Plays the backend sweep confirming a watched name free — what the real
   * `runWatchSweep` does when `domain:check` answers avail
   * (functions/src/domain/watches.ts). The next listWatches then carries the
   * `available` state マイページ turns into its banner.
   */
  markWatchAvailable(domainName: string): void {
    const name = domainName.toLowerCase()
    const watch = watches.find((entry) => entry.domainName === name)
    if (!watch || watch.state !== 'watching') {
      throw new Error(`no watching entry for "${domainName}" to mark available`)
    }
    watches = watches.map((entry) =>
      entry.domainName === name
        ? { ...entry, state: 'available', availableAt: new Date().toISOString() }
        : entry,
    )
  },
}

/** Drop-in replacement for src/api/callable.ts invoke() under vi.mock. */
export async function fakeInvoke<TReq, TRes>(
  name: string,
  data: TReq,
  options: { signal?: AbortSignal } = {},
): Promise<TRes> {
  if (options.signal?.aborted) throw options.signal.reason
  callCounts[name] = (callCounts[name] ?? 0) + 1
  const handler = overrides.get(name) ?? DEFAULT_HANDLERS[name]
  if (!handler) {
    throw new ApiError({
      kind: 'notFound',
      status: 404,
      message: `no fake handler for callable "${name}"`,
      code: 'functions/not-found',
    })
  }
  return (await handler(data)) as TRes
}
