/**
 * Mutation/reconciliation coordinator for domain/contact/host updates.
 *
 * This is the first non-idempotent-mutation reconciliation logic in the
 * codebase. The registry PUT itself (`domain:update` / `contact:update` /
 * `host:update`, and `host:create`) is `idempotent: false` and must be sent
 * at most once per operation attempt; this module exists so the Callable
 * layer never has to decide "should I resend the PUT?" on its own. After a
 * mutation, authoritative state always comes from a follow-up registry
 * `info` call, never from re-applying the caller's original request body.
 *
 * State machine (persisted on `{resourceDocument}/operations/{operationId}`):
 *
 *   reserved -> prepared -> dispatching -> registryAccepted -> reconciling
 *     -> succeeded | notApplied | indeterminate
 *   (any phase) -> rejected   [markMutationRejected, non-transport failure]
 *
 * Every write to the operation document is a compare-and-set gated on the
 * document's current `phase`, so a stale or duplicated handler invocation
 * (e.g. an at-least-once retry) can never overwrite a state a newer
 * invocation already reached. Terminal phases strip the stored before/expected
 * projections, since they may carry PII, keeping only the hash/result/
 * timestamp fields the architecture calls for.
 */
import {
  FieldValue,
  Firestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import {db} from "../config/firebase.js";
import type {RegistryClient} from "../bridge/registryClient.js";
import {adhocClTrid} from "./clTrid.js";
import type {OwnedResource} from "./ownership.js";

/** Registry-mutating commands this coordinator can front. */
export type RegistryMutationCommand =
  | "domain:update"
  | "contact:update"
  | "host:update"
  | "host:create";

/** Lifecycle of one mutation attempt, persisted on the operation document. */
export type OperationPhase =
  | "reserved"
  | "prepared"
  | "dispatching"
  | "registryAccepted"
  | "reconciling"
  | "succeeded"
  | "rejected"
  | "notApplied"
  | "indeterminate";

/** Outcome of comparing post-mutation `info` against the stored intent. */
export type ReconcileDecision = "applied" | "notApplied" | "indeterminate";

/** Sparse "touched fields" snapshot, comparable against a fresh `info` read. */
export type RegistryProjection = Record<string, unknown>;

const TERMINAL_PHASES: readonly OperationPhase[] = [
  "succeeded",
  "rejected",
  "notApplied",
  "indeterminate",
];

/**
 * @param {OperationPhase} phase Phase to classify.
 * @return {boolean} Whether the phase is terminal (no further writes).
 */
function isTerminalPhase(phase: OperationPhase): boolean {
  return (TERMINAL_PHASES as string[]).includes(phase);
}

/** Why `beginMutation` (or a resumed replay) could not proceed. */
export type MutationConflictReason =
  | "concurrent_operation"
  | "resource_not_ready"
  | "hash_mismatch";

/**
 * Raised when a mutation cannot be reserved or resumed. `reason` is mapped by
 * the API layer: `concurrent_operation`/`resource_not_ready` -> `aborted` or
 * `failed-precondition`; `hash_mismatch` -> `invalid-argument` (same
 * `operationId` reused for a materially different request).
 */
export class MutationConflictError extends Error {
  readonly reason: MutationConflictReason;

  /**
   * @param {MutationConflictReason} reason Why the mutation was rejected.
   * @param {string} message Human-readable, client-safe reason.
   */
  constructor(reason: MutationConflictReason, message: string) {
    super(message);
    this.name = "MutationConflictError";
    this.reason = reason;
  }
}

/** Handle returned by `beginMutation`, threaded through the rest of a call. */
export interface MutationLease {
  target: OwnedResource;
  operationId: string;
  operationRef: DocumentReference;
  command: RegistryMutationCommand;
  requestHash: string;
  /** True when this lease resumed an existing operation document. */
  resumed: boolean;
  phase: OperationPhase;
  beforeProjection?: RegistryProjection;
  expectedProjection?: RegistryProjection;
  clTRID?: string;
}

const OPERATIONS_SUBCOLLECTION = "operations";

/**
 * @param {OwnedResource} target Owned resource a mutation targets.
 * @return {string} The resource's canonical key, for the operation document.
 */
function resourceKeyOf(target: OwnedResource): string {
  switch (target.kind) {
  case "domain":
    return target.name;
  case "contact":
    return target.contactId;
  case "host":
    return target.name;
  }
}

/**
 * Reserves (or resumes) one mutation attempt against `target`.
 *
 * Runs inside a Firestore transaction so that two concurrent callers racing
 * to mutate the same resource cannot both win: whichever transaction commits
 * first sets `activeOperationId`, and the loser observes it on retry and is
 * rejected with `concurrent_operation`.
 *
 * Replay semantics: the same `operationId` with the same `requestHash`
 * resumes the stored operation (`resumed: true`) without touching the
 * resource lock again; the same `operationId` with a *different* hash is
 * rejected (`hash_mismatch`) rather than silently applied.
 *
 * @param {OwnedResource} target Ownership-checked resource to mutate.
 * @param {string} operationId Caller-supplied idempotency key.
 * @param {RegistryMutationCommand} command Command this operation performs.
 * @param {string} requestHash Stable hash of the normalised request body.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<MutationLease>} Lease to thread through the rest of the
 *   Callable.
 */
export async function beginMutation(
  target: OwnedResource,
  operationId: string,
  command: RegistryMutationCommand,
  requestHash: string,
  firestore: Firestore = db(),
): Promise<MutationLease> {
  const operationRef = target.ref
    .collection(OPERATIONS_SUBCOLLECTION)
    .doc(operationId);

  return firestore.runTransaction(async (tx) => {
    // Both reads must happen before any write in this transaction.
    const resourceSnap = await tx.get(target.ref);
    const operationSnap = await tx.get(operationRef);

    const resourceData = resourceSnap.data();
    if (!resourceData) {
      // The ownership check that produced `target` already confirmed this
      // document existed; if it is gone now, something else raced us.
      throw new MutationConflictError(
        "concurrent_operation",
        "対象リソースが見つかりませんでした。",
      );
    }

    const existing = operationSnap.data();
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new MutationConflictError(
          "hash_mismatch",
          "同一の operationId で内容の異なる要求が送信されました。",
        );
      }
      return {
        target,
        operationId,
        operationRef,
        command,
        requestHash,
        resumed: true,
        phase: existing.phase as OperationPhase,
        beforeProjection: existing.beforeProjection as
          | RegistryProjection
          | undefined,
        expectedProjection: existing.expectedProjection as
          | RegistryProjection
          | undefined,
        clTRID: existing.clTRID as string | undefined,
      };
    }

    // `syncState`/`activeOperationId` are the mutation concurrency lock,
    // shared by all three resource kinds. They are distinct from each
    // kind's own creation-lifecycle field (`syncState` legacy-absent-ready
    // for domains, `state` for contacts, `lifecycleState` for hosts) that
    // `ownership.ts` already checked before this function was called; a
    // resource can be "created and usable" yet still have a mutation lock
    // held from a prior, still-in-flight operation.
    const syncState = resourceData.syncState as string | undefined;
    if (syncState !== undefined && syncState !== "ready") {
      throw new MutationConflictError(
        "resource_not_ready",
        "対象リソースは更新できない状態です。",
      );
    }
    const activeOperationId = resourceData.activeOperationId as
      | string
      | undefined;
    if (activeOperationId !== undefined && activeOperationId !== operationId) {
      throw new MutationConflictError(
        "concurrent_operation",
        "別の操作が進行中です。",
      );
    }

    const now = FieldValue.serverTimestamp();
    tx.set(
      target.ref,
      {syncState: "updating", activeOperationId: operationId, updatedAt: now},
      {merge: true},
    );
    tx.set(operationRef, {
      uid: target.uid,
      kind: target.kind,
      resourceKey: resourceKeyOf(target),
      registry: target.registry,
      command,
      requestHash,
      phase: "reserved",
      createdAt: now,
      updatedAt: now,
    });

    return {
      target,
      operationId,
      operationRef,
      command,
      requestHash,
      resumed: false,
      phase: "reserved",
    };
  });
}

/**
 * Compare-and-set phase transition: only writes when the document is
 * currently in `allowedFrom`; a document already at `to` is treated as an
 * idempotent no-op (a retried caller observing its own prior success); a
 * document elsewhere (already advanced further, or terminal) is left
 * untouched rather than clobbered.
 *
 * @param {Firestore} firestore Firestore handle.
 * @param {DocumentReference} ref Operation document to transition.
 * @param {OperationPhase[]} allowedFrom Phases this transition may start from.
 * @param {OperationPhase} to Phase to transition to.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
async function advancePhase(
  firestore: Firestore,
  ref: DocumentReference,
  allowedFrom: readonly OperationPhase[],
  to: OperationPhase,
): Promise<void> {
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!data) return;
    const phase = data.phase as OperationPhase;
    if (phase === to) return;
    if (!allowedFrom.includes(phase)) return;
    tx.update(ref, {phase: to, updatedAt: FieldValue.serverTimestamp()});
  });
}

/**
 * Stores the before/expected projections and the clTRID that will be used
 * for the registry PUT, and advances the operation to `prepared`.
 *
 * A no-op once the operation has moved past `prepared` (dispatch already
 * started): projections must never be rewritten after the PUT may have been
 * sent, since they are what reconciliation trusts to classify the outcome.
 *
 * @param {MutationLease} lease Lease returned by `beginMutation`.
 * @param {RegistryProjection} beforeProjection Touched-field snapshot before
 *   the mutation.
 * @param {RegistryProjection} expectedProjection Touched-field snapshot the
 *   mutation is expected to produce.
 * @param {string} clTRID Deterministic clTRID that will be used for the PUT.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
export async function prepareMutation(
  lease: MutationLease,
  beforeProjection: RegistryProjection,
  expectedProjection: RegistryProjection,
  clTRID: string,
  firestore: Firestore = db(),
): Promise<void> {
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(lease.operationRef);
    const data = snap.data();
    if (!data) return;
    const phase = data.phase as OperationPhase;
    if (phase !== "reserved" && phase !== "prepared") return;
    tx.update(lease.operationRef, {
      phase: "prepared",
      beforeProjection,
      expectedProjection,
      clTRID,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * Marks the operation as "about to send the registry PUT". Called once,
 * immediately before the Callable issues the (non-retried) registry call.
 *
 * @param {MutationLease} lease Lease returned by `beginMutation`.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
export async function markMutationDispatching(
  lease: MutationLease,
  firestore: Firestore = db(),
): Promise<void> {
  await advancePhase(
    firestore,
    lease.operationRef,
    ["prepared"],
    "dispatching",
  );
}

/**
 * Marks the operation as "the registry accepted the PUT". Called once the
 * registry call returns success; from this point on the mutation may have
 * happened, and the coordinator never resends it — only `info` re-reads.
 *
 * @param {MutationLease} lease Lease returned by `beginMutation`.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
export async function markRegistryAccepted(
  lease: MutationLease,
  firestore: Firestore = db(),
): Promise<void> {
  await advancePhase(
    firestore,
    lease.operationRef,
    ["dispatching"],
    "registryAccepted",
  );
}

/**
 * Marks an operation as rejected because the registry call itself failed
 * with a definitive, non-transport error (the mutation provably did not
 * apply) and returns the resource to `ready`. Not part of the reconciliation
 * happy path; called by the Callable layer from its `catch` block. A no-op
 * once the operation is already terminal.
 *
 * @param {MutationLease} lease Lease returned by `beginMutation`.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
export async function markMutationRejected(
  lease: MutationLease,
  firestore: Firestore = db(),
): Promise<void> {
  await firestore.runTransaction(async (tx) => {
    const opSnap = await tx.get(lease.operationRef);
    const resourceSnap = await tx.get(lease.target.ref);

    const opData = opSnap.data();
    if (!opData || isTerminalPhase(opData.phase as OperationPhase)) return;

    const now = FieldValue.serverTimestamp();
    tx.update(lease.operationRef, {
      phase: "rejected",
      result: "rejected",
      updatedAt: now,
      completedAt: now,
      beforeProjection: FieldValue.delete(),
      expectedProjection: FieldValue.delete(),
    });

    const resourceData = resourceSnap.data();
    if (resourceData?.activeOperationId === lease.operationId) {
      tx.set(
        lease.target.ref,
        {
          syncState: "ready",
          activeOperationId: FieldValue.delete(),
          updatedAt: now,
        },
        {merge: true},
      );
    }
  });
}

/**
 * Result of `enterReconciling`: either the operation was already terminal
 * (`terminal` set, nothing to do), or it is safely in `reconciling` and
 * `before`/`expected` are the projections to classify the fresh `info`
 * response against.
 */
interface ReconcileEntry {
  terminal?: ReconcileDecision;
  before?: RegistryProjection;
  expected?: RegistryProjection;
}

/**
 * Atomically checks for an already-terminal result, advances the operation
 * to `reconciling` if needed, and reads back the before/expected projections
 * — all inside one transaction.
 *
 * This must be one transaction, not three separate steps: `lease`'s own
 * `beforeProjection`/`expectedProjection` fields are only a point-in-time
 * snapshot from `beginMutation` (`prepareMutation` persists to Firestore but
 * returns `void`, per its architecture signature, so it cannot hand back an
 * updated lease). Reading the projections back from Firestore in a separate,
 * later call would race a concurrent duplicate invocation's `finalize` step,
 * which deletes them once terminal — a stale/duplicate handler could then
 * read `undefined` and misclassify a genuinely applied mutation as
 * `indeterminate`. Reading them in the same transaction that confirms the
 * phase is exactly `reconciling` (and not yet terminal) guarantees the
 * values cannot have been deleted out from under this call: Firestore
 * retries this transaction against the latest committed state on any
 * conflicting concurrent write.
 *
 * @param {Firestore} firestore Firestore handle.
 * @param {DocumentReference} ref Operation document to inspect/advance.
 * @return {Promise<ReconcileEntry>} Terminal result, or projections to use.
 */
async function enterReconciling(
  firestore: Firestore,
  ref: DocumentReference,
): Promise<ReconcileEntry> {
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!data) return {};

    const phase = data.phase as OperationPhase;
    if (phase === "succeeded") return {terminal: "applied"};
    if (phase === "notApplied") return {terminal: "notApplied"};
    if (phase === "indeterminate") return {terminal: "indeterminate"};

    if (phase === "registryAccepted") {
      tx.update(ref, {
        phase: "reconciling",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      before: data.beforeProjection as RegistryProjection | undefined,
      expected: data.expectedProjection as RegistryProjection | undefined,
    };
  });
}

/**
 * Normalises a value for order-insensitive structural comparison: primitive
 * arrays (nameservers, statuses, ...) are compared as sets, since add/remove
 * semantics do not guarantee the registry echoes them back in request order;
 * object keys are sorted so key order never affects the comparison.
 *
 * @param {unknown} value Value to normalise.
 * @return {unknown} Comparable, order-independent representation.
 */
function normaliseForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(normaliseForComparison);
    const allPrimitive = items.every(
      (item) => item === null || typeof item !== "object",
    );
    return allPrimitive ? [...items].sort() : items;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, val]) => [key, normaliseForComparison(val)] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * @param {unknown} a First value.
 * @param {unknown} b Second value.
 * @return {boolean} Whether the two values are structurally equal, ignoring
 *   array/object key order.
 */
function projectionValuesEqual(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normaliseForComparison(a)) ===
    JSON.stringify(normaliseForComparison(b))
  );
}

/**
 * @param {RegistryProjection} actual Freshly read registry projection.
 * @param {RegistryProjection | undefined} expected Stored projection to
 *   compare against.
 * @return {boolean} Whether every touched field in `expected` matches.
 */
function matchesProjection(
  actual: RegistryProjection,
  expected: RegistryProjection | undefined,
): boolean {
  if (!expected) return false;
  return Object.keys(expected).every((key) =>
    projectionValuesEqual(actual[key], expected[key]),
  );
}

/**
 * @param {RegistryProjection} actual Freshly read registry projection.
 * @param {RegistryProjection | undefined} before Stored pre-mutation
 *   projection.
 * @param {RegistryProjection | undefined} expected Stored expected
 *   post-mutation projection.
 * @return {ReconcileDecision} `applied` when `actual` matches `expected`,
 *   `notApplied` when it still matches `before`, `indeterminate` otherwise.
 */
function classify(
  actual: RegistryProjection,
  before: RegistryProjection | undefined,
  expected: RegistryProjection | undefined,
): ReconcileDecision {
  if (matchesProjection(actual, expected)) return "applied";
  if (matchesProjection(actual, before)) return "notApplied";
  return "indeterminate";
}

/**
 * Derives a registry projection from a freshly read `info` object: every
 * enumerable field except the identity fields used for routing (never the
 * caller's original request body, always the registry's own answer).
 *
 * @param {object} info Normalised `info*` response from the RegistryClient.
 * @param {string[]} identityFields Fields to exclude (name/id/registry —
 *   routing, not mutable state).
 * @return {RegistryProjection} Authoritative, PII-scoped projection.
 */
function projectInfo(
  info: object,
  identityFields: readonly string[],
): RegistryProjection {
  const source = info as Record<string, unknown>;
  const result: RegistryProjection = {};
  for (const [key, value] of Object.entries(source)) {
    if (identityFields.includes(key) || value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Finalises one reconciliation attempt: CAS-writes the terminal operation
 * phase (stripping any PII-bearing projections) and, only when `decision` is
 * `applied`, CAS-writes the authoritative mirror fields onto the resource
 * document. A no-op if a concurrent invocation already finalised this
 * operation, or if the resource's active-operation lock has already moved on
 * (both are stale/duplicate-handler guards, not expected in normal
 * operation).
 *
 * @param {Firestore} firestore Firestore handle.
 * @param {MutationLease} lease Lease this reconciliation attempt is for.
 * @param {ReconcileDecision} decision Outcome to persist.
 * @param {RegistryProjection} mirrorFields Authoritative fields to merge into
 *   the resource document when `decision === "applied"`.
 * @return {Promise<void>} Resolves once the CAS attempt completes.
 */
async function finalizeReconciliation(
  firestore: Firestore,
  lease: MutationLease,
  decision: ReconcileDecision,
  mirrorFields: RegistryProjection,
): Promise<void> {
  const phase: OperationPhase =
    decision === "applied" ?
      "succeeded" :
      decision === "notApplied" ?
        "notApplied" :
        "indeterminate";
  const resourceSyncState =
    decision === "indeterminate" ? "reconciliationRequired" : "ready";

  await firestore.runTransaction(async (tx) => {
    const opSnap = await tx.get(lease.operationRef);
    const resourceSnap = await tx.get(lease.target.ref);

    const opData = opSnap.data();
    if (!opData || opData.phase !== "reconciling") return;

    const now = FieldValue.serverTimestamp();
    tx.update(lease.operationRef, {
      phase,
      result: decision,
      updatedAt: now,
      completedAt: now,
      beforeProjection: FieldValue.delete(),
      expectedProjection: FieldValue.delete(),
    });

    const resourceData = resourceSnap.data();
    if (resourceData?.activeOperationId !== lease.operationId) return;

    const resourceUpdate: Record<string, unknown> = {
      syncState: resourceSyncState,
      updatedAt: now,
    };
    if (resourceSyncState === "ready") {
      resourceUpdate.activeOperationId = FieldValue.delete();
      resourceUpdate.lastSyncedAt = now;
    }
    if (decision === "applied") {
      Object.assign(resourceUpdate, mirrorFields);
    }
    tx.set(lease.target.ref, resourceUpdate, {merge: true});
  });
}

const DOMAIN_IDENTITY_FIELDS = ["domain", "registry"] as const;
const CONTACT_IDENTITY_FIELDS = ["id", "contactId", "registry"] as const;
const HOST_IDENTITY_FIELDS = ["name", "registry", "parentDomain"] as const;

/**
 * Re-reads the domain from the registry and reconciles the mirror.
 *
 * @param {MutationLease} lease Lease for a `domain:update` operation.
 * @param {RegistryClient} client Registry client to re-read `info` from.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<ReconcileDecision>} `applied` / `notApplied` /
 *   `indeterminate`.
 */
export async function reconcileDomainMirror(
  lease: MutationLease,
  client: RegistryClient,
  firestore: Firestore = db(),
): Promise<ReconcileDecision> {
  if (lease.target.kind !== "domain") {
    throw new Error("reconcileDomainMirror: lease target is not a domain");
  }
  const entry = await enterReconciling(firestore, lease.operationRef);
  if (entry.terminal) return entry.terminal;
  const {before, expected} = entry;

  const clTRID = adhocClTrid("INFO", `${lease.operationId}-post`);
  const info = await client.infoDomain(lease.target.name, clTRID);
  const projection = projectInfo(info, DOMAIN_IDENTITY_FIELDS);
  const decision = classify(projection, before, expected);

  await finalizeReconciliation(firestore, lease, decision, projection);
  return decision;
}

/**
 * Re-reads the contact from the registry and reconciles the mirror.
 *
 * @param {MutationLease} lease Lease for a `contact:update` operation.
 * @param {RegistryClient} client Registry client to re-read `info` from.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<ReconcileDecision>} `applied` / `notApplied` /
 *   `indeterminate`.
 */
export async function reconcileContactMirror(
  lease: MutationLease,
  client: RegistryClient,
  firestore: Firestore = db(),
): Promise<ReconcileDecision> {
  if (lease.target.kind !== "contact") {
    throw new Error("reconcileContactMirror: lease target is not a contact");
  }
  const entry = await enterReconciling(firestore, lease.operationRef);
  if (entry.terminal) return entry.terminal;
  const {before, expected} = entry;

  const clTRID = adhocClTrid("INFO", `${lease.operationId}-post`);
  const info = await client.infoContact(lease.target.contactId, clTRID);
  const projection = projectInfo(info, CONTACT_IDENTITY_FIELDS);
  const decision = classify(projection, before, expected);

  await finalizeReconciliation(firestore, lease, decision, projection);
  return decision;
}

/**
 * Re-reads the host from the registry and reconciles the mirror.
 *
 * @param {MutationLease} lease Lease for a `host:update` operation.
 * @param {RegistryClient} client Registry client to re-read `info` from.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<ReconcileDecision>} `applied` / `notApplied` /
 *   `indeterminate`.
 */
export async function reconcileHostMirror(
  lease: MutationLease,
  client: RegistryClient,
  firestore: Firestore = db(),
): Promise<ReconcileDecision> {
  if (lease.target.kind !== "host") {
    throw new Error("reconcileHostMirror: lease target is not a host");
  }
  const entry = await enterReconciling(firestore, lease.operationRef);
  if (entry.terminal) return entry.terminal;
  const {before, expected} = entry;

  const clTRID = adhocClTrid("INFO", `${lease.operationId}-post`);
  const info = await client.infoHost(lease.target.name, clTRID);
  const projection = projectInfo(info, HOST_IDENTITY_FIELDS);
  const decision = classify(projection, before, expected);

  await finalizeReconciliation(firestore, lease, decision, projection);
  return decision;
}
