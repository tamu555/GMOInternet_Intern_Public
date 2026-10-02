# FIXME / TODO

Known, deliberately-unresolved issues that need a follow-up decision or fix.
Items here are not blockers for the PR/feature they were discovered in, but
must not be forgotten.

## Ownership checks and per-domain mutation locking are forked 4 ways / 3 ways

**Discovered**: 2026-08-25, while merging `origin/main` into the EPP Update
command feature branch (`worktree-feature-update`, PR
[#14](https://github.com/tomokioooka323/GMOIntenetIC_TeamC/pull/14)).

**Status**: Not fixed. Each affected command works correctly in isolation;
the gap only appears when two of them race on the same domain.

### The problem

The codebase now has **four independent, mutually-unaware implementations**
of "does this caller own this domain / is it in a state that's safe to
mutate":

| Implementation | File | Used by |
|---|---|---|
| `assertOwnsDomain`/`assertOwnsContact`/`assertOwnsHost` | `functions/src/domain/ownership.ts` | `updateDomain`, `updateContact`, `updateHost`, `createHost` |
| `getOwnedDomain` | `functions/src/domain/domainRepository.ts` | `getDomainInfo`, `listDomains` |
| `loadOwnedDomain` / `syncDomainRecord` | `functions/src/domain/domainRecords.ts` | `provisionDomain.ts` (create), `domainLifecycle.ts` (delete/restore) |
| an inline uid/name/registry check inside `acquireRenewLease()` | `functions/src/domain/renewDomain.ts` | `renewOrder` |

None of these share a schema or read/write each other's fields.
`ownership.ts` gates on a `syncState` field that none of the other three
paths ever read or write (safe by construction — an absent `syncState` is
treated as ready — but still four separate code paths implementing the same
concept).

On top of that, there are **three independent, mutually-unaware per-domain
mutation-concurrency mechanisms**:

| Mechanism | File | Guards |
|---|---|---|
| `syncState`/`activeOperationId` + `operations` Firestore subcollection | `functions/src/domain/updateMirrors.ts` | `updateDomain`, `updateContact`, `updateHost` |
| a domain-scoped `renewLease` field (5-minute TTL, token-fenced) on the `domains/{uid}__{name}` doc | `functions/src/domain/renewDomain.ts` | `renewOrder` |
| **no lock at all** | `functions/src/domain/domainLifecycle.ts` | `deleteDomain`, `restoreDomain` |

**Concrete consequence**: a `domain:update` holding `syncState: "updating"`
does **not** block a concurrent `domain:delete`, and vice versa. Nothing in
`domainLifecycle.ts` checks `syncState`/`activeOperationId`, and nothing in
`updateMirrors.ts`/`ownership.ts` checks `renewLease`. Two racing mutating
calls on the same domain from different commands can both proceed, each
believing it has exclusive access.

### Why it wasn't fixed on the spot

This gap only became visible when the EPP Update feature branch (which added
`ownership.ts`/`updateMirrors.ts`) was merged with `origin/main` (which had,
in the meantime, independently grown `domainRepository.ts`/
`domainRecords.ts`/`renewDomain.ts`/`domainLifecycle.ts` while implementing
renew/delete/restore/info). Unifying four ownership checks and three
concurrency mechanisms into one is a cross-cutting design decision spanning
every mutating domain command, not something to resolve unilaterally inside
either feature's merge.

### What a fix should do

- Pick one canonical ownership/readiness-check implementation (most likely
  `domain/ownership.ts`, since it already models domain/contact/host
  uniformly) and migrate `getDomainInfo`/`listDomains`/`provisionDomain`/
  `domainLifecycle`/`renewDomain` onto it.
- Pick one canonical per-domain mutation lock (most likely `updateMirrors.ts`'s
  `syncState`/`activeOperationId` model, or generalize `renewDomain.ts`'s
  lease pattern) and have every mutating command (`updateDomain`,
  `updateContact`, `updateHost`, `createHost`, `renewOrder`, `deleteDomain`,
  `restoreDomain`) acquire and respect the same lock before touching a
  domain.
- Add a regression test that starts two different mutating commands
  concurrently against the same domain and asserts only one succeeds.

### Related, narrower gap: unverified wire shapes

Also flagged in the EPP Update feature's implementation plan ("Open Items"):
some wire shapes in `functions/src/bridge/types.ts` were modeled defensively
from existing conventions and EPP RFC shapes because
the team's spec draft never documented these bodies. Current status
per shape (2026-08-27, checked against the registries' OpenAPI documents,
which are not included in this public repository):

- `host:create`/`host:update` (and `host:info`): **resolved.** No longer
  `PROVISIONAL` — the comments in `types.ts` now say they were verified
  against the Kitaqsign OpenAPI document, and a re-check against both
  registries' OpenAPI documents confirms the shapes match.
- `contact:update`: **unresolved, and actually mismatched.** `types.ts`
  still marks `ContactUpdateRequest` as `PROVISIONAL`, and the implementation
  sends `{"chg": {...}}` while both registries' `ContactUpdateRequest`
  schemas define a flat body (`postalInfo`/`voice`/`fax`/`email`/`authInfo`
  at top level, no `chg` wrapper). The client code (and
  `registryClient.test.ts`, which pins the `{chg: ...}` shape) needs fixing
  or a live-Swagger confirmation that the wrapper is accepted.
- DNSSEC (`secDNS`) wire placement: **unresolved.** Still `PROVISIONAL`;
  neither registry's OpenAPI document mentions `secDNS`/`dsData` at all, so
  it can only be settled against live Swagger or a real request.

## RGP restore: the fee is shown but never charged

**Discovered**: 2026-08-26, while closing the audit findings on the
delete/restore (RGP) feature (`functions/src/domain/domainLifecycle.ts`,
`frontend/src/features/mypage/`).

**Status**: Deliberately not fixed. The restore flow itself is correct and
tested; the gap below is a product decision. The two items that used to sit
next to it — the assumed grace period and the reconciler's UI consequence —
were closed by the 2026-08-26 registry spec update (see §2 and §3).

### 1. `restoreFeeYen` is quoted to the member, but no order is ever created

`priceForRestore()` (`functions/src/domain/pricing.ts`) is now surfaced end to
end: the delete dialog warns what a later restore would cost, and the restore
confirmation repeats it before the member commits. **Nothing bills it.**
`restoreDomain` performs the registry command directly; it does not go through
the order contract (`OrderKind` is still `create | renew`), so there is no
pseudo-payment, no idempotency key, and no order record for a restore.

The product requirements call for an extra fee on restore, so either:

- restore becomes a third `OrderKind` and reuses the FIG.1 order machinery
  (pseudo payment → provisioning → done), inheriting no-double-charge for
  free; or
- the fee is billed out of band and the UI wording must say when and how.

Until one is chosen, the screens promise a charge the system never makes.

### 2. ✅ CLOSED (2026-08-26 spec update): the grace period is documented

Both registries now state the same RGP state machine: `domain:delete` moves
the domain to `redemptionPeriod` (**plus** `pendingDelete`), it stays
restorable for `grace-period-days` (**45 days**), a per-minute batch then
drops `redemptionPeriod` — `domain:restore` answers **2304** from that point
— and the name is purged `pending-delete-days` (**5 days**) later.
`domain:delete` also returns the window's end as
`extension.pendingDeleteUntil`.

Landed with the spec refresh: the 🔬 hedge is gone from
`RESTORE_GRACE_PERIOD_DAYS`; `extension.pendingDeleteUntil` is plumbed
through `RegistryClient.deleteDomain` → `DomainDeleteOutcome` → the mirror's
`restorableUntil`, and preferred over `deletedAt + 45d`; restorability is
gated on `redemptionPeriod` instead of `pendingDelete`; and
`GRACE_PERIOD_EXPLANATION` says 45 日 (plus the short non-restorable tail).

#### 2a. Still empirical: which array carries `redemptionPeriod`

The status table in both `info.description`s lists `redemptionPeriod` among
`domain:info`'s **`status`** values, while `DomainResponse.rgpStatus`
describes RGP statuses as a **separate layer** — and the local stub puts it
in `rgpStatus`. Both readings are therefore accepted (`isRestorable()` in
`functions/src/domain/domainRecords.ts`, `canRestore()` in
`frontend/src/features/mypage/domainDisplay.ts`), so nothing depends on the
answer. Spec test 3 keeps a checklist line for measuring it.

### 3. ✅ MOSTLY CLOSED: the screens now hide 復旧 outside the window

The list and detail screens no longer offer 復旧 for a domain that is not in
`redemptionPeriod`, or whose `restorableUntil` has passed, and they never
render a negative countdown; `restoreOwnedDomain` refuses that case locally
rather than issuing a command the registry is documented to reject with 2304.

What is left is the mirror going stale: nothing polls the registry for
domains whose window quietly ended, so a mirror can keep saying
「解約手続き中」until someone acts on the domain. That is the same job as §4.

### 4. No pending-transfer reconciler: the losing side never hears about an auto-approve

**Discovered**: 2026-08-26, from the registry spec update that finally
documented the poll message shape.

Both registries route each transfer notification to exactly one registrar:
`request`/`cancel` to the **losing** side, `approve`/`reject` to the
**gaining** side. The 20-minute auto-approve (spec 6.6.1) is no exception:
an auto-approved request also notifies only the gaining side.

So when a member ignores an inbound transfer request, the domain leaves and
**nothing tells us**: `transfers/{uid}__{name}` stays `pending` and the
`domains` mirror still lists a domain we no longer sponsor.
`functions/test/integration/transfer.test.ts` pins this as the current
behaviour ("leaves the losing side pending when the registry auto-approves").

**Resolved (2026-08-27)** — `functions/src/domain/transferReconciler.ts`,
run after every queue drain (the scheduled `pollWorker` and the manual
`drainPollQueue`). Evidence-based: `domain:info` absent/unreadable or a
fresh `transferPeriod` RGP stamp ⇒ the transfer completed (mirror → gone);
window closed with the domain intact ⇒ `cancelled` after `autoApproveAt`.
The same run sweeps `pendingDelete` mirrors (§3): 404 ⇒ purged, otherwise
the registry state is written back. Idempotency rides the existing
`claimTransfer` tokens, so a member's own in-flight command always wins.

A second bug fell out of the same investigation:
`recordTransferNotification` treated *any* `request` over a settled record
as a redelivery and skipped it, so a domain gained earlier could never be
requested away again — no approval screen, and the mirror kept showing the
domain as 使用可能 after it left. Redelivery detection now compares the poll
message id (a true redelivery is the same message, same id).
Tests: `functions/test/integration/transfer.test.ts`（reconciler 4本 +
再オープン + 同一ID再配達）.

## A newly registered domain has no nameservers, and nobody has measured what happens when it gets some

**Discovered**: 2026-08-26, while removing the `host:create` pre-flight a
previous change had put in front of `domain:create`
(`functions/src/domain/provisionDomain.ts`).

**Status**: The purchase flow is fixed and tested. What is left is one
measurement and one screen.

### The decision that was taken (option A, §3.9 of the spec draft)

`domain:create` carries **no** `nameservers`. The domain lands in the
documented `inactive` status, the requested nameservers (if the member typed
any) are attached afterwards by `domain:update`, and a refusal there is
recorded on the order (`result.nameserverError`) instead of failing it. A
settled payment is never put at risk by a DNS detail, and the flow never
creates registrar-wide shared host objects on a member's behalf.

The application form's default nameservers
(`ns1/ns2.teamc-dns.example` — a reserved TLD, nobody's servers) are gone;
the default is now 「いまは設定しない」.

### 1. 🔬 The `domain:update` half is still unmeasured

Spec §3.9 records a *hypothesis* that both registries reject a nameserver
whose host object does not exist. Spec test 2 (§9.2) is still unchecked and
no measurement artifact exists, so it is unknown whether

- `domain:create` really rejects such a nameserver (the claim that started
  this), and
- `domain:update`'s `add.nameservers` rejects it too.

If the second one does, then the future NS screen — not the purchase flow —
needs a `host:create` step, and it needs an answer for the fact that host
objects are shared registrar-wide and cannot be deleted once referenced.
The team's spec draft (§9.2) has a checklist line for exactly this.

### 2. Nothing yet offers to finish an NS attachment that failed

`Order.result.nameserverError` is written and logged, and the completion
screen already tells the member the domain is 「まだインターネットに公開されて
いません」, but no screen reads that field or offers a retry. The existing
NS-change UI (`frontend/src/features/mypage/NameserverDialog.tsx`,
`frontend/src/features/dns/NsChangeMode.tsx`) is where the member ends up, so
the gap is a hand-off, not a missing capability.

## ✅ 解消（2026-08-28）: `autoRenewCancelableUntil` now has a backend source

`StatusBadges.tsx` renders 「自動で1年延びました（取り消すなら残り◯日）」
when `rgpStatus` contains `autoRenewPeriod`; the parenthetical needs
`autoRenewCancelableUntil`, which used to be hardcoded to `undefined` in
`myDomainsApi.ts` (only the MSW mock db seeded it), so the deadline hint was
missing in real-backend mode — the review finding 「自動更新取り消しまで◯◯日
表示がフロントにだけある」.

Fixed exactly as planned, mirroring `restorableUntil`: when the list DTO sees
`autoRenewPeriod` (in `rgpStatus` or `status` — same documents-disagree hedge
as `redemptionPeriod`), `listDomains` derives the deadline as
`(exDate - 1 year) + 45 days` (`functions/src/domain/gracePeriod.ts`
`autoRenewCancelableUntilOf`, wired in `domainRepository.ts`) and the frontend
maps it through (`myDomainsApi.ts`). Still informational only: the
pseudo-registry implements neither auto-renew billing nor the refund that
cancelling within the window would trigger.
