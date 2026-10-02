/**
 * My-page domain management API (docs/api-flow-diagrams.html FIG.9-10),
 * now speaking Firebase callables through invoke().
 *
 * All-real backend (stub→real switch complete):
 *
 *   real functions/ codebase
 *   ------------------------------
 *   listDomains    (一覧 FIG.9)
 *   getDomainInfo  (詳細 FIG.10)
 *   updateDomain   (NS / locks)
 *   updateAutoRenew (autoRenew)
 *   deleteDomain   (廃止 FIG.4)
 *   restoreDomain  (RGP復旧)
 *   rotateAuthInfo (AuthCode再生成)
 *
 * 移管 (IN / OUT) is NOT here: FIG.3 と FIG.9 の移管導線はすべて実バックエンドの
 * transfer callable 群を話す transferApi.ts が持つ.
 *
 * Adapter notes for the real endpoints:
 * - listDomains speaks {status, rgpStatus, exDate|null}; renamed here to the
 *   FE {statuses, rgpStatuses, exDate}. restorableUntil comes from it too (a
 *   server-derived RGP deadline, non-null only while the domain really is
 *   restorable), and so does autoRenewCancelableUntil (derived server-side
 *   from exDate while autoRenewPeriod is on — gracePeriod.ts is the single
 *   source of the 45-day rule).
 * - getDomainInfo (live domain:info) deliberately NEVER returns authInfo
 *   (security decision in functions/), and neither does the Firestore mirror
 *   keep one, so the detail adapter starts the masked-copy UI empty. The one
 *   sanctioned way to obtain the code is rotateAuthInfo, which re-mints it at
 *   the registry and answers it exactly once (spec §3.9): the screen holds
 *   that answer in memory and nothing can read it back afterwards.
 *   autoRenew lives only in the Firestore mirror, so the detail adapter
 *   merges it from listDomains (best-effort, extra call).
 *   paymentMethod has no backend at all → 'valid' placeholder.
 * - updateDomain is delta-based (add/remove) with a required operationId and
 *   returns a MutationResult, not the domain: this adapter diffs the FE's
 *   full-replacement patch against the current live state, then re-fetches.
 *   autoRenew goes through the real updateAutoRenew (mirror-only write — the
 *   registry has no OFF switch, §3.6/§6.4; a pendingDelete domain is refused
 *   with failed-precondition, matching the disabled switch in the UI).
 *
 * Renewal is NOT here: FIG.10 routes it through the order contract
 * (ordersApi.ts kind=renew → real renewOrder) so the pseudo payment, retry
 * and no-double-charge machinery is reused as-is.
 */
import { invoke } from './callable'

export type RegistryId = 'kitaqsign' | 'kitaqnic'

/** The four client* lock statuses (§3.5) as UI-facing booleans. */
export type DomainLocks = {
  transfer: boolean
  update: boolean
  delete: boolean
  renew: boolean
}

export type MyDomainSummary = {
  name: string
  registry: RegistryId
  /**
   * Which section the domain belongs to. `gone` covers a completed outbound
   * transfer and a deletion past its redemption window: the member no longer
   * holds the name, so it renders in the 使用不可 section, never links to
   * the detail screen, and no operation can target it (the same name may
   * already be someone else's).
   */
  lifecycle: 'active' | 'pendingDelete' | 'gone'
  /** Set only when lifecycle === 'gone': 移管済み or 復旧不可. */
  goneReason?: 'transferred' | 'unrecoverable' 
  /** spec §3.5 statuses (RFC 5731), e.g. ["ok"] or ["clientTransferProhibited"]. */
  statuses: string[]
  /** RGP statuses (§3.6), e.g. ["autoRenewPeriod"]. */
  rgpStatuses: string[]
  /** ISO 8601. */
  exDate: string
  /**
   * アプリ側フラグ (§6.4) — the registry itself has no OFF switch (§3.6);
   * OFF is honoured by the app-side BATCH delete at exDate (TBD #15).
   */
  autoRenew: boolean
  /** pendingDelete only: until when restore is expected to succeed (🔬 テスト3). */
  restorableUntil?: string
  /** rgpStatuses に autoRenewPeriod があるとき: 取り消し可能期限 (§6.4). */
  autoRenewCancelableUntil?: string
}

export type MyDomainDetail = MyDomainSummary & {
  /** ISO 8601. */
  registeredAt: string
  nameservers: string[]
  /** Masked on screen, copy-only (spec §7.3). */
  authInfo: string
  /** 支払い方法の状態 (§6.4: ドメインを失う原因の筆頭なので常時表示). */
  paymentMethod: 'valid' | 'expired'
}

export type MyDomainUpdate = {
  autoRenew?: boolean
  nameservers?: string[]
  locks?: Partial<DomainLocks>
}

const LOCK_STATUSES: Record<keyof DomainLocks, string> = {
  transfer: 'clientTransferProhibited',
  update: 'clientUpdateProhibited',
  delete: 'clientDeleteProhibited',
  renew: 'clientRenewProhibited',
}

/** Derives the UI lock switches from the §3.5 status list (single source). */
export function locksFromStatuses(statuses: string[]): DomainLocks {
  return {
    transfer: statuses.includes(LOCK_STATUSES.transfer),
    update: statuses.includes(LOCK_STATUSES.update),
    delete: statuses.includes(LOCK_STATUSES.delete),
    renew: statuses.includes(LOCK_STATUSES.renew),
  }
}

/** Wire shape of real listDomains (functions/src/domain/domainRepository.ts). */
type DomainListItemWire = {
  name: string
  tld: string
  registry: RegistryId
  status: string[]
  rgpStatus: string[]
  exDate: string | null
  autoRenew: boolean
  /**
   * Server-derived RGP restore deadline: the registry's own
   * extension.pendingDeleteUntil, or deletedAt + the registry's 45-day grace
   * period. Null unless the domain is in redemptionPeriod right now.
   */
  restorableUntil: string | null
  restoreFeeYen: number
  /**
   * Server-derived cancel deadline for a registry-side auto-renew: non-null
   * only while the domain carries autoRenewPeriod (§3.6).
   */
  autoRenewCancelableUntil?: string | null
  /** Which list section the domain belongs to; "gone" = 使用不可. */
  lifecycle?: 'active' | 'pendingDelete' | 'gone'
  /** Why a gone domain left us. */
  goneReason?: 'transferred' | 'unrecoverable' | null
}

/** Wire shape of real getDomainInfo (functions/src/domain/getDomainInfo.ts). */
type DomainInfoWire = {
  domain: string
  registry: RegistryId
  status: string[]
  registrant: string
  contacts: Record<string, string>
  nameservers: string[]
  crDate: string
  upDate: string | null
  exDate: string | null
  trDate: string | null
  rgpStatus: string[]
}

/** Wire shape of real updateDomain's answer (updateCallableSupport.ts). */
type MutationResultWire = {
  operationId: string
  resourceName: string
  state: 'ready'
  recovered: boolean
}

function summaryFromListItem(item: DomainListItemWire): MyDomainSummary {
  // Older mocks/fixtures predate the lifecycle field; derive it the same way
  // the backend does for legacy mirrors.
  const lifecycle =
    item.lifecycle ??
    (item.status.includes('gone')
      ? 'gone'
      : item.status.includes('pendingDelete')
        ? 'pendingDelete'
        : 'active')
  return {
    name: item.name,
    registry: item.registry,
    lifecycle,
    goneReason:
      lifecycle === 'gone' ? (item.goneReason ?? 'unrecoverable') : undefined,
    statuses: item.status,
    rgpStatuses: item.rgpStatus,
    exDate: item.exDate ?? '',
    autoRenew: item.autoRenew,
    // The deadline is derived server-side (single source: gracePeriod.ts) and
    // is null unless the domain is restorable right now.
    restorableUntil: item.restorableUntil ?? undefined,
    // Same server-side derivation rule as restorableUntil (gracePeriod.ts).
    autoRenewCancelableUntil: item.autoRenewCancelableUntil ?? undefined,
  }
}

/**
 * Wire shape of the real deleteDomain/restoreDomain callables
 * (functions/src/domain/domainLifecycle.ts LifecycleResult). restoreFeeYen
 * and message have no slot in MyDomainDetail and are dropped for now.
 */
type LifecycleResultWire = {
  domainName: string
  registry: string
  lifecycle: 'active' | 'pendingDelete' | 'gone'
  status: string[]
  rgpStatus: string[]
  exDate?: string | null
  alreadyInState: boolean
  restoreFeeYen?: number
  message: string
}

/**
 * Folds a LifecycleResult into the MyDomainDetail the screens expect. The
 * registry answer is authoritative for the lifecycle fields; the static
 * fields (nameservers, ...) are refreshed best-effort from the real detail
 * lookup, which can legitimately fail right after a lifecycle change.
 */
async function detailFromLifecycle(result: LifecycleResultWire): Promise<{ domain: MyDomainDetail }> {
  let base: MyDomainDetail | null = null
  try {
    base = (await fetchMyDomain(result.domainName)).domain
  } catch {
    // Live detail unavailable (e.g. mirror already gone); placeholders below.
  }
  const fallbackIso = new Date().toISOString()
  return {
    domain: {
      name: result.domainName,
      registry: result.registry === 'kitaqnic' ? 'kitaqnic' : 'kitaqsign',
      lifecycle: result.lifecycle,
      statuses: result.status,
      rgpStatuses: result.rgpStatus,
      exDate: result.exDate ?? base?.exDate ?? fallbackIso,
      autoRenew: base?.autoRenew ?? false,
      restorableUntil: base?.restorableUntil,
      autoRenewCancelableUntil: base?.autoRenewCancelableUntil,
      registeredAt: base?.registeredAt ?? fallbackIso,
      nameservers: base?.nameservers ?? [],
      authInfo: base?.authInfo ?? '',
      paymentMethod: base?.paymentMethod ?? 'valid',
    },
  }
}

export async function fetchMyDomains(signal?: AbortSignal): Promise<{ domains: MyDomainSummary[] }> {
  const result = await invoke<Record<string, never>, { domains: DomainListItemWire[] }>(
    'listDomains',
    {},
    { signal },
  )
  return { domains: result.domains.map(summaryFromListItem) }
}

export async function fetchMyDomain(name: string, signal?: AbortSignal): Promise<{ domain: MyDomainDetail }> {
  // autoRenew and the RGP restore deadline live only in the mirror
  // (listDomains); fetched in parallel and merged best-effort so a list
  // failure cannot take the whole detail down.
  const [info, mirrored] = await Promise.all([
    invoke<{ domainName: string }, DomainInfoWire>('getDomainInfo', { domainName: name }, { signal }),
    fetchMyDomains(signal)
      .then((list) => list.domains.find((domain) => domain.name === name))
      .catch(() => undefined),
  ])
  return {
    domain: {
      name: info.domain,
      registry: info.registry,
      // getDomainInfo answers not-found for a gone mirror, so a detail that
      // loaded is by definition a held domain; the mirror refines the bucket.
      lifecycle: mirrored?.lifecycle ?? 'active',
      // Live registry state wins for the statuses the restore gate reads.
      statuses: info.status,
      rgpStatuses: info.rgpStatus,
      exDate: info.exDate ?? '',
      autoRenew: mirrored?.autoRenew ?? false,
      restorableUntil: mirrored?.restorableUntil,
      // Like autoRenew/restorableUntil this lives only in the list DTO, so
      // the detail merges it from the same best-effort mirror fetch.
      autoRenewCancelableUntil: mirrored?.autoRenewCancelableUntil,
      registeredAt: info.crDate,
      nameservers: info.nameservers,
      // Never returned by the backend (see module doc comment).
      authInfo: '',
      paymentMethod: 'valid',
    },
  }
}

/** Wire shape of the real updateDomain request (validation.ts §domain:update). */
type DomainUpdateChangeSetWire = {
  nameservers?: string[]
  statuses?: string[]
}

function normaliseHosts(hosts: string[]): string[] {
  return hosts.map((host) => host.trim()).filter((host) => host.length > 0)
}

/** Wire shape of the real updateAutoRenew (functions/src/api/updateAutoRenew.ts). */
type AutoRenewResultWire = {
  domainName: string
  autoRenew: boolean
}

function setAutoRenewFlag(name: string, autoRenew: boolean): Promise<AutoRenewResultWire> {
  return invoke<{ domainName: string; autoRenew: boolean }, AutoRenewResultWire>('updateAutoRenew', {
    domainName: name,
    autoRenew,
  })
}

export async function updateMyDomain(name: string, patch: MyDomainUpdate): Promise<{ domain: MyDomainDetail }> {
  const touchesRegistry = patch.nameservers !== undefined || patch.locks !== undefined

  if (!touchesRegistry) {
    // autoRenew-only: mirror flag via the real updateAutoRenew (§6.4).
    if (patch.autoRenew !== undefined) await setAutoRenewFlag(name, patch.autoRenew)
    const refreshed = (await fetchMyDomain(name)).domain
    if (patch.autoRenew !== undefined) refreshed.autoRenew = patch.autoRenew
    return { domain: refreshed }
  }

  // Delta computation against the live state (the real updateDomain is
  // add/remove-based, not full-replacement).
  const current = (await fetchMyDomain(name)).domain
  const add: DomainUpdateChangeSetWire = {}
  const remove: DomainUpdateChangeSetWire = {}

  if (patch.nameservers !== undefined) {
    const wanted = normaliseHosts(patch.nameservers)
    const wantedSet = new Set(wanted)
    const currentSet = new Set(current.nameservers)
    const toAdd = wanted.filter((host) => !currentSet.has(host))
    const toRemove = current.nameservers.filter((host) => !wantedSet.has(host))
    if (toAdd.length > 0) add.nameservers = toAdd
    if (toRemove.length > 0) remove.nameservers = toRemove
  }

  if (patch.locks !== undefined) {
    const addStatuses: string[] = []
    const removeStatuses: string[] = []
    for (const [key, status] of Object.entries(LOCK_STATUSES) as Array<[keyof DomainLocks, string]>) {
      const wanted = patch.locks[key]
      if (wanted === undefined) continue
      const has = current.statuses.includes(status)
      if (wanted && !has) addStatuses.push(status)
      if (!wanted && has) removeStatuses.push(status)
    }
    if (addStatuses.length > 0) add.statuses = addStatuses
    if (removeStatuses.length > 0) remove.statuses = removeStatuses
  }

  const hasDelta = Object.keys(add).length > 0 || Object.keys(remove).length > 0
  if (hasDelta) {
    // An empty diff would be rejected as failed-precondition by the backend,
    // hence the guard; operationId is this mutation's idempotency key.
    await invoke<
      { operationId: string; domainName: string; add?: DomainUpdateChangeSetWire; remove?: DomainUpdateChangeSetWire },
      MutationResultWire
    >('updateDomain', {
      operationId: crypto.randomUUID(),
      domainName: name,
      ...(Object.keys(add).length > 0 ? { add } : {}),
      ...(Object.keys(remove).length > 0 ? { remove } : {}),
    })
  }

  if (patch.autoRenew !== undefined) {
    await setAutoRenewFlag(name, patch.autoRenew)
  }

  const refreshed = (await fetchMyDomain(name)).domain
  if (patch.autoRenew !== undefined) refreshed.autoRenew = patch.autoRenew
  return { domain: refreshed }
}

export async function deleteMyDomain(name: string): Promise<{ domain: MyDomainDetail }> {
  // Real backend (registry-backed): a not-found ApiError propagates as-is.
  const result = await invoke<{ domainName: string }, LifecycleResultWire>('deleteDomain', {
    domainName: name,
  })
  return detailFromLifecycle(result)
}

export async function restoreMyDomain(name: string): Promise<{ domain: MyDomainDetail }> {
  // Real backend (registry-backed): a not-found ApiError propagates as-is.
  const result = await invoke<{ domainName: string }, LifecycleResultWire>('restoreDomain', {
    domainName: name,
  })
  return detailFromLifecycle(result)
}

/**
 * Wire shape of the real rotateAuthInfo callable
 * (functions/src/domain/rotateAuthInfo.ts AuthInfoRotationResult). The
 * registry mints the value and answers it once; the backend stores no copy,
 * so this response is the only place it ever exists on this side.
 */
type AuthInfoRotationWire = {
  domainName: string
  registry: RegistryId
  authInfo: string
  rotatedAt: string
  message: string
}

export async function rotateAuthInfo(name: string): Promise<{ authInfo: string }> {
  // Real backend (registry-backed): §3.9 POST /domains/{name}/rotate-auth-info.
  const result = await invoke<{ domainName: string }, AuthInfoRotationWire>('rotateAuthInfo', {
    domainName: name,
  })
  return { authInfo: result.authInfo }
}
