/**
 * Domain status -> beginner-facing label + tone (spec §3.5, RFC 5731).
 *
 * ⚠️ Colour never carries the meaning on its own (§3.5: 色覚多様性対応) - the
 * label text is always rendered next to the tone class. `inactive` has the
 * spec-fixed wording "まだインターネットに公開されていません" (NS not set yet).
 */

export type DomainStatusTone = 'ok' | 'inactive' | 'pending' | 'ending' | 'hold' | 'locked' | 'neutral'

export type DomainStatusLabel = {
  status: string
  label: string
  tone: DomainStatusTone
}

const STATUS_LABELS: Record<string, Omit<DomainStatusLabel, 'status'>> = {
  ok: { label: '使えています', tone: 'ok' },
  inactive: { label: 'まだインターネットに公開されていません', tone: 'inactive' },
  pendingTransfer: { label: '引っ越しの手続き中です', tone: 'pending' },
  pendingDelete: { label: '解約手続き中です', tone: 'ending' },
  // RGP (RFC 3915). Both registries: delete puts the domain here for 45 days,
  // and this - not pendingDelete on its own - is what makes 復旧 possible.
  redemptionPeriod: { label: 'いまなら復旧できます', tone: 'ending' },
  clientHold: { label: '一時停止中です', tone: 'hold' },
  clientTransferProhibited: { label: '引っ越しをロック中', tone: 'locked' },
  clientUpdateProhibited: { label: '変更をロック中', tone: 'locked' },
  clientDeleteProhibited: { label: '解約をロック中', tone: 'locked' },
  clientRenewProhibited: { label: '更新をロック中', tone: 'locked' },
}

/** Unknown statuses pass through verbatim with a neutral tone - never hidden. */
export function labelForDomainStatus(status: string): DomainStatusLabel {
  const known = STATUS_LABELS[status]
  if (!known) return { status, label: status, tone: 'neutral' }
  return { status, ...known }
}
