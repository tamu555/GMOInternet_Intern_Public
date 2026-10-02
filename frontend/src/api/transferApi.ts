/**
 * 移管 (spec §6.6 / FIG.3 上帯=移管IN・下帯=移管OUT / FIG.9) — the single client
 * for the REAL transfer callables in `functions/src/api/transferCallables.ts`.
 *
 *   | callable            | side    | request                    |
 *   |---------------------|---------|----------------------------|
 *   | `requestTransfer`   | gaining | `{domainName, authInfo}`   |
 *   | `cancelTransfer`    | gaining | `{domainName}`             |
 *   | `respondTransfer`   | losing  | `{domainName, action}`     |
 *   | `listTransfers`     | both    | `{}`                       |
 *   | `getTransferStatus` | both    | `{domainName}`             |
 *
 * ⚠️ Everything is keyed by `domainName`, not by an opaque request id: the
 * backend's document id is `${uid}__${domainName}` and a member can only have
 * one transfer of one domain in flight, so the domain *is* the key
 * (`functions/src/domain/transfers.ts`).
 *
 * ⚠️ `listTransfers` answers with the PENDING transfers only, in both
 * directions (`listPendingTransfers` in transferDomain.ts). A settled transfer
 * therefore disappears from the list rather than turning into a result row —
 * the FIG.9 「結果行」 is rebuilt from `getTransferStatus`, which reads one
 * record whatever state it is in (see TransferInSection.tsx).
 *
 * The state vocabulary is translated ONCE here: `transferPresentation()` is
 * the only place a backend `state` becomes a Japanese badge, so no screen has
 * to reason about `'pending' | 'completed' | ...` itself.
 */
import { invoke } from './callable'
import { firebaseEmulatorEnabled } from '../config'
import type { RegistryId } from './myDomainsApi'

/** Which way the domain is moving, from this service's point of view. */
export type TransferDirection =
  /** We are the gaining registrar: the member is bringing a domain in. */
  | 'in'
  /** We are the losing registrar: somebody is asking for our domain. */
  | 'out'

/** Where a transfer stands (`functions/src/domain/transfers.ts`). */
export type TransferState = 'pending' | 'completed' | 'rejected' | 'cancelled' | 'failed'

export type TransferAction = 'approve' | 'reject'

/** Wire shape of every transfer callable's answer (TransferResult, functions/). */
type TransferResultWire = {
  domainName: string
  registry: RegistryId
  direction: TransferDirection
  state: TransferState
  gainingRegistrar: string | null
  losingRegistrar: string | null
  requestedAt: string | null
  autoApproveAt: string | null
  /** True when `domain:info` proved the outcome rather than the command. */
  recovered: boolean
  message: string
}

export type Transfer = {
  domainName: string
  registry: RegistryId
  direction: TransferDirection
  state: TransferState
  /** ISO 8601, or null when the registry never told us when it was requested. */
  requestedAt: string | null
  /** ⚠️ §6.6.1: ISO 8601 deadline after which the registry approves by itself. */
  autoApproveAt: string | null
  /** Japanese one-liner authored by the backend; safe to show as-is. */
  message: string
}

/**
 * Badge tones, a subset of the §3.5 `DomainStatusTone` vocabulary so the rows
 * can reuse `STATUS_TONE_CLASSES` without this module depending on a feature.
 */
export type TransferTone = 'ok' | 'pending' | 'ending' | 'neutral'

export type TransferPresentation = {
  label: string
  tone: TransferTone
}

/**
 * 移管IN: WE asked for the domain, so every wording is about 移管元's answer.
 * Consistent with domainStatusLabels.ts (「引っ越しの手続き中です」ほか).
 */
const IN_PRESENTATION: Record<TransferState, TransferPresentation> = {
  pending: { label: '移管元の承認待ちです', tone: 'pending' },
  completed: { label: '移管が完了しました', tone: 'ok' },
  rejected: { label: '移管元に拒否されました', tone: 'ending' },
  cancelled: { label: '申請を取り下げました', tone: 'neutral' },
  failed: { label: '移管を開始できませんでした', tone: 'ending' },
}

/** 移管OUT: somebody asked for OUR domain, so the member is the one deciding. */
const OUT_PRESENTATION: Record<TransferState, TransferPresentation> = {
  pending: { label: '移管申請が届いています', tone: 'pending' },
  completed: { label: '移管を承認しました', tone: 'ok' },
  rejected: { label: '移管申請を拒否しました', tone: 'neutral' },
  cancelled: { label: '移管申請は取り消されました', tone: 'neutral' },
  failed: { label: '移管処理は完了しませんでした', tone: 'ending' },
}

/** THE state → badge mapping. Screens must not re-derive labels from `state`. */
export function transferPresentation(
  transfer: Pick<Transfer, 'direction' | 'state'>,
): TransferPresentation {
  const table = transfer.direction === 'out' ? OUT_PRESENTATION : IN_PRESENTATION
  return table[transfer.state] ?? { label: transfer.state, tone: 'neutral' }
}

/** True once the other registrar (or the 20-minute clock) has decided. */
export function isSettledTransfer(transfer: Pick<Transfer, 'state'>): boolean {
  return transfer.state !== 'pending'
}

function toTransfer(wire: TransferResultWire): Transfer {
  return {
    domainName: wire.domainName,
    registry: wire.registry,
    direction: wire.direction,
    state: wire.state,
    requestedAt: wire.requestedAt,
    autoApproveAt: wire.autoApproveAt,
    message: wire.message,
  }
}

/**
 * 移管IN の申請 (§6.6.2 step 4). A re-submitted form answers with the request
 * already in flight instead of raising a second one (the backend keys on the
 * domain), so the caller never has to guard against a double submit.
 *
 * Error wording comes from the backend (§6.7): 2202 / HTTP 401 arrives as
 * `invalid-argument` with `details.field = 'authInfo'`, an unsupported TLD as
 * `invalid-argument` with `details.field = 'domainName'` — both surface as
 * `ApiError.fieldErrors` (see callable.ts).
 */
export async function requestTransferIn(domainName: string, authInfo: string): Promise<Transfer> {
  const result = await invoke<{ domainName: string; authInfo: string }, TransferResultWire>(
    'requestTransfer',
    { domainName, authInfo },
  )
  return toTransfer(result)
}

/** Every transfer of the member's that is still waiting on somebody. */
export async function fetchPendingTransfers(signal?: AbortSignal): Promise<Transfer[]> {
  const result = await invoke<Record<string, never>, { transfers: TransferResultWire[] }>(
    'listTransfers',
    {},
    { signal },
  )
  return result.transfers.map(toTransfer)
}

/** 移管IN の進行中一覧 (FIG.9 移管IN進捗区画). */
export async function fetchTransferInRequests(signal?: AbortSignal): Promise<Transfer[]> {
  const transfers = await fetchPendingTransfers(signal)
  return transfers.filter((transfer) => transfer.direction === 'in')
}

/** 移管OUT の承認待ち一覧 (FIG.9 移管OUT通知バナー / FIG.3 下帯). */
export async function fetchTransferOutRequests(signal?: AbortSignal): Promise<Transfer[]> {
  const transfers = await fetchPendingTransfers(signal)
  return transfers.filter((transfer) => transfer.direction === 'out')
}

/** 移管IN の取り下げ (§6.6.1: gaining は承認前なら cancel できる). */
export async function cancelTransferIn(domainName: string): Promise<Transfer> {
  const result = await invoke<{ domainName: string }, TransferResultWire>('cancelTransfer', {
    domainName,
  })
  return toTransfer(result)
}

/** 移管OUT の承認 / 拒否 (FIG.3 下帯). Approving is irreversible. */
export async function respondTransferOut(
  domainName: string,
  action: TransferAction,
): Promise<Transfer> {
  const result = await invoke<{ domainName: string; action: TransferAction }, TransferResultWire>(
    'respondTransfer',
    { domainName, action },
  )
  return toTransfer(result)
}

/**
 * Best-effort drain of the registry poll queues so transfer notifications
 * land in Firestore (`drainPollQueue`, functions/src/api/drainPollQueue.ts).
 * Emulator-only: the emulator never fires schedules, so screens that need
 * fresh transfer state trigger a drain first. Against a deployed project this
 * is a no-op — the 5-minute scheduled `pollWorker` already drains there, and
 * a client-triggered drain from every open tab was the main driver of the
 * Firestore read growth (poll + reconcile pipeline per call). Failures are
 * the caller's to swallow — this is a nudge, not a fetch.
 */
export async function drainTransferNotifications(signal?: AbortSignal): Promise<void> {
  if (!firebaseEmulatorEnabled()) return
  await invoke<Record<string, never>, unknown>('drainPollQueue', {}, { signal })
}

/** The drain currently running, shared by every caller. */
let drainInFlight: Promise<void> | null = null

/**
 * マイページ本体 (MyPage.tsx) と移管IN区画 (TransferInSection.tsx) の再取得間隔。
 * ⚠️ 2 つの区画で必ず同じ値を使う。片方だけ遅いと、待っているあいだ 1 画面の
 * なかで移管の状態が食い違う（下の ensureTransferNotificationsDrained が
 * 直したのと同じ症状が、30 秒ごとに戻ってくる）。
 */
export const TRANSFER_REFRESH_MS = 30_000

/**
 * ドレインを待つのをあきらめるまでの時間。
 *
 * ⚠️ これが無いと、レジストリに繋がらないときに画面が丸ごと止まる。callable の
 * 上限は `CALLABLE_TIMEOUT_MS`（125 秒）で、ドレインは共有なので、その 125 秒の
 * あいだマイページのドメイン一覧も移管一覧も描かれない — `listDomains` は即答
 * できるのに、である。ドレインは「つついて新しくする」だけの操作で、読み取り
 * そのものではないから、待つのをやめて **今 Firestore にある状態を出す** ほうが
 * 正しい。投げたドレイン自体は取り消さない（次の再取得までに間に合えばよい）。
 */
const DRAIN_MAX_WAIT_MS = 8_000

/**
 * 「まずキューを流してから読む」を、画面をまたいで **1 回だけ** にする
 * （2026-08-28）。
 *
 * ⚠️ これが無いと起きること: マイページは `load()` の先頭でドレインしてから
 * `listTransfers` を読むのに、同じ画面に同居する移管IN区画
 * （`TransferInSection`）は自前でドレインせずに読んでいた。つまり
 *
 *   - 移管IN区画 = ドレイン **前** の状態（まだ pending）
 *   - ドメイン一覧・移管OUT = ドレイン **後** の状態（移管済み）
 *
 * が同じ画面に並び、次にリロードすると移管IN区画だけが遅れて追いつく。
 * 「リロードするたびに移管の状態が変わる」の正体はこれ。
 *
 * 実行中のドレインがあれば、それを待つだけで新しくは投げない。マイページ本体と
 * 移管IN区画は同じコミットで立ち上がり、再取得も同じ拍で動くので、これだけで
 * レジストリを 2 度叩かずに済む。時間でキャッシュはしない — 「最近流したから
 * 省く」は、押した直後に古い状態を見せる側に倒れる。
 *
 * 待つのは最大 `DRAIN_MAX_WAIT_MS`、かつ呼び出し側が中断（`signal`）したらそこで
 * 待つのをやめる。⚠️ 中断してもドレイン自体は止めない — 共有しているので、
 * 1 つの画面がアンマウントしただけで他の待ち手の分まで取り消すことになる。
 *
 * 失敗は握りつぶす: これは取得ではなく「つつく」操作で、本体の読み取りは
 * 呼び出し側がこの後で必ず行う。
 */
export function ensureTransferNotificationsDrained(signal?: AbortSignal): Promise<void> {
  if (!drainInFlight) {
    drainInFlight = drainTransferNotifications()
      .catch(() => {})
      .then(() => {
        drainInFlight = null
      })
  }

  const drain = drainInFlight
  return new Promise<void>((resolve) => {
    let settled = false
    const giveUp = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
      resolve()
    }
    const timer = setTimeout(giveUp, DRAIN_MAX_WAIT_MS)
    signal?.addEventListener('abort', giveUp, { once: true })
    void drain.then(giveUp)
  })
}

/**
 * One transfer's current state, whatever it is — the only way to learn how a
 * transfer that left the pending list actually ended (`not-found` when the
 * member never had a transfer of that domain).
 */
export async function fetchTransferStatus(
  domainName: string,
  signal?: AbortSignal,
): Promise<Transfer> {
  const result = await invoke<{ domainName: string }, TransferResultWire>(
    'getTransferStatus',
    { domainName },
    { signal },
  )
  return toTransfer(result)
}
