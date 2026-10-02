/**
 * Shared helpers for the four EPP Update Callables (`updateDomain.ts`,
 * `updateContact.ts`, `updateHost.ts`, `createHost.ts`): request hashing,
 * projection comparison, terminal-phase classification, terminal-replay
 * result building, and the ownership-resume wrapper. Centralised here so the
 * request-hash algorithm and terminal-phase classification cannot silently
 * drift between the four Callables.
 */
import {createHash} from "node:crypto";
import {HttpsError} from "firebase-functions/v2/https";
import type {DocumentReference} from "firebase-admin/firestore";
import type {RegistryId} from "../config/options";
import {OwnershipError, type OwnedResource} from "../domain/ownership";
import type {MutationLease, OperationPhase} from "../domain/updateMirrors";
import {ReconciliationRequiredError} from "./httpsErrors";

/** Result shape returned by every EPP Update Callable. */
export interface MutationResult {
  operationId: string;
  resourceName: string;
  state: "ready";
  /** True when this invocation resumed a prior attempt rather than doing
   * fresh work end to end (replay of the same `operationId`). */
  recovered: boolean;
}

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
export function isTerminalPhase(phase: OperationPhase): boolean {
  return (TERMINAL_PHASES as string[]).includes(phase);
}

/**
 * @param {unknown} value Value to canonicalise.
 * @return {string} A string that is identical for structurally-equal values
 *   regardless of object key order (array order is preserved: it is
 *   semantically meaningful in a request body, unlike in a registry
 *   projection comparison).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {unknown} value Normalised request content (never includes
 *   `operationId` itself, which is the idempotency key, not part of the
 *   content being keyed).
 * @return {string} Stable hash used to detect a replayed `operationId` whose
 *   payload has changed.
 */
export function computeRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * @param {unknown} a First projection.
 * @param {unknown} b Second projection.
 * @return {boolean} Whether the two registry projections are equal, treating
 *   arrays as order-insensitive sets (add/remove semantics never guarantee
 *   the registry echoes elements back in request order).
 */
export function projectionsEqual(a: unknown, b: unknown): boolean {
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(normalise);
      const allPrimitive = items.every(
        (item) => item === null || typeof item !== "object",
      );
      return allPrimitive ? [...items].sort() : items;
    }
    if (v !== null && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => [k, normalise(val)] as const)
        .sort(([x], [y]) => x.localeCompare(y));
      return Object.fromEntries(entries);
    }
    return v;
  };
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/** Overrides for {@link terminalReplayResult}'s default messages/behaviour. */
export interface TerminalReplayOptions {
  /** Overrides the default `notApplied` message (`createHost` uses "作成"
   * instead of "更新" since nothing existed before this attempt). */
  notAppliedMessage?: string;
  /** Called for the `"rejected"` phase; returning an `HttpsError` overrides
   * the generic message. Used by `createHost` to map a stored EPP `2302`
   * conflict to `already-exists` instead of a generic retry message. */
  onRejected?: () => HttpsError | undefined;
}

/**
 * Builds the {@link MutationResult} for a terminal (already-decided) lease.
 *
 * @param {MutationLease} lease Terminal lease.
 * @param {string} resourceName Canonical resource name/id.
 * @param {TerminalReplayOptions} options Per-Callable message overrides.
 * @return {MutationResult} Result for a `succeeded` replay.
 */
export function terminalReplayResult(
  lease: MutationLease,
  resourceName: string,
  options: TerminalReplayOptions = {},
): MutationResult {
  switch (lease.phase) {
  case "succeeded":
    return {
      operationId: lease.operationId,
      resourceName,
      state: "ready",
      recovered: true,
    };
  case "indeterminate":
    throw new ReconciliationRequiredError();
  case "notApplied":
    throw new HttpsError(
      "failed-precondition",
      options.notAppliedMessage ??
        "更新内容は反映されませんでした。新しい operationId で再試行してください。",
    );
  default: // "rejected"
    throw (
      options.onRejected?.() ??
      new HttpsError(
        "failed-precondition",
        "この操作は処理できませんでした。新しい operationId で再試行してください。",
      )
    );
  }
}

/**
 * @param {unknown} value Candidate registry value from Firestore.
 * @return {boolean} Whether the value is a recognised registry id.
 */
export function isRegistryId(value: unknown): value is RegistryId {
  return value === "kitaqsign" || value === "kitaqnic";
}

/**
 * Wraps an `assertOwns*` call, tolerating exactly one extra case: the
 * resource is owned but `not_ready` because *this exact* `operationId` is
 * the one holding the mutation lock (e.g. a prior attempt left the
 * operation at `dispatching` after a transport-ambiguous PUT). Resuming
 * that lease is how reconciliation ever completes — see
 * `domain/updateMirrors.ts`'s module doc "再実行" — so the Callable layer is
 * the only place positioned to make that exception; the generic
 * `ownership.ts` gate intentionally stays operation-id-agnostic.
 *
 * On any other failure (including `not_owned`), the original error is
 * re-thrown unchanged: a caller who does not own the resource can never
 * reach the resume branch, regardless of which `operationId` they supply.
 *
 * @param {function(): Promise<T>} assertOwns The resource-specific
 *   `assertOwns*` call.
 * @param {DocumentReference} ref Ref of the resource's mirror document.
 * @param {string} operationId Idempotency key on the current request.
 * @param {function(Record<string, unknown>): (T | undefined)} buildResumed
 *   Re-validates resource-specific identity fields on the raw document and
 *   builds the typed `Owned*` result, or returns `undefined` if they don't
 *   match (in which case the original `OwnershipError` is re-thrown).
 * @return {Promise<T>} The owned resource, resumed or fresh.
 * @template T
 */
export async function assertOwnsOrResumeOwnOperation<T extends OwnedResource>(
  assertOwns: () => Promise<T>,
  ref: DocumentReference,
  operationId: string,
  buildResumed: (data: Record<string, unknown>) => T | undefined,
): Promise<T> {
  try {
    return await assertOwns();
  } catch (error) {
    if (!(error instanceof OwnershipError) || error.reason !== "not_ready") {
      throw error;
    }
    const snapshot = await ref.get();
    const data = snapshot.data();
    if (!data || data.activeOperationId !== operationId) throw error;
    const resumed = buildResumed(data);
    if (!resumed) throw error;
    return resumed;
  }
}
