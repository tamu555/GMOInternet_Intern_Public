/**
 * Translation from internal failures to Callable error codes.
 *
 * The UI only ever sees these, so the mapping is where "what went wrong"
 * turns into "what the user is told".
 */
import {HttpsError} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {isRegistryError} from "../bridge/errors";
import {DomainLifecycleError} from "../domain/domainLifecycle";
import {DomainNotOwnedError} from "../domain/domainRecords";
import {ValidationError} from "../domain/validation";
import {OwnershipError} from "../domain/ownership";
import {TransferError} from "../domain/transferDomain";
import {MutationConflictError} from "../domain/updateMirrors";

/**
 * Raised when a mutation's registry outcome could not be confirmed: either
 * the mutating PUT/POST itself failed with a `transport` RegistryError (the
 * command may or may not have run), or the post-mutation `info` re-read
 * matched neither the expected nor the prior state (`indeterminate`).
 *
 * Mapped to `failed-precondition`, deliberately not `unavailable`: the
 * mutation may already have applied, so a client that auto-retries on
 * `unavailable` could double-submit a non-idempotent PUT/POST. The correct
 * client behaviour is to re-invoke with the *same* `operationId`, which
 * resumes reconciliation from Firestore without resending the registry call
 * (`functions/src/domain/updateMirrors.ts`).
 */
export class ReconciliationRequiredError extends Error {
  /**
   * @param {string} message Human-readable, client-safe reason.
   */
  constructor(
    message = "更新結果を確認できませんでした。同じ操作でしばらくしてから再度お試しください。",
  ) {
    super(message);
    this.name = "ReconciliationRequiredError";
  }
}

/**
 * Maps any thrown value onto an HttpsError.
 *
 * Registry credentials, clTRIDs and internal messages are deliberately kept
 * out of the client-facing message; they stay in Cloud Logging and in the
 * RegistryLog collection.
 *
 * @param {unknown} error Whatever was thrown.
 * @param {string} context Short label for the log line.
 * @return {HttpsError} Error safe to send to the client.
 */
export function toHttpsError(error: unknown, context: string): HttpsError {
  if (error instanceof HttpsError) return error;

  if (error instanceof ValidationError) {
    return new HttpsError("invalid-argument", error.message, {
      field: error.field,
    });
  }

  if (error instanceof OwnershipError) {
    // "missing" and "foreign owner" are already collapsed into the same
    // message by ownership.ts; this layer must not re-introduce a
    // distinction (e.g. by picking a different HttpsError code) that would
    // let a caller infer which case occurred.
    return error.reason === "not_ready" ?
      new HttpsError("failed-precondition", error.message) :
      new HttpsError("permission-denied", error.message);
  }

  if (error instanceof MutationConflictError) {
    switch (error.reason) {
    case "concurrent_operation":
      return new HttpsError("aborted", error.message);
    case "resource_not_ready":
      return new HttpsError("failed-precondition", error.message);
    case "hash_mismatch":
      return new HttpsError("invalid-argument", error.message);
    default:
      return new HttpsError("internal", "処理できませんでした。");
    }
  }

  if (error instanceof TransferError) {
    switch (error.reason) {
    case "authInfoMismatch":
      // Deliberately `invalid-argument`, not `permission-denied`: the member
      // mistyped a field they can fix, not a permission they lack (spec 6.7's
      // wording for 2202).
      return new HttpsError("invalid-argument", error.userMessage, {
        field: "authInfo",
      });
    case "busy":
      return new HttpsError("aborted", error.userMessage);
    case "registryDown":
      // Retryable and shown as such; retrying a transfer request is safe
      // because a duplicate is answered with 2304 (already pending), which
      // the wizard already explains.
      return new HttpsError("unavailable", error.userMessage);
    case "alreadyOurs":
    case "notPending":
    case "indeterminate":
      return new HttpsError("failed-precondition", error.userMessage);
    default:
      return new HttpsError("permission-denied", error.userMessage);
    }
  }

  if (error instanceof ReconciliationRequiredError) {
    return new HttpsError("failed-precondition", error.message);
  }

  if (error instanceof DomainNotOwnedError) {
    // Deliberately "not-found" rather than "permission-denied": telling a
    // caller that a domain exists but belongs to someone else would leak
    // which names other members hold.
    logger.warn(`${context}: domain not owned by caller`, {
      domainName: error.domainName,
    });
    return new HttpsError("not-found", "対象のドメインが見つかりません。");
  }

  if (error instanceof DomainLifecycleError) {
    switch (error.reason) {
    case "gone":
      return new HttpsError("not-found", error.userMessage);
    case "notSponsored":
      return new HttpsError("permission-denied", error.userMessage);
    case "registryMoved":
    case "registryUnverified":
      // Both are "ask again in a moment", not "this failed": the first has
      // already healed the stale mirror so the retry routes to the registry
      // that really holds the domain, and the second wrote nothing at all.
      // `unavailable` is the code the client already retries on, and neither
      // case can have half-applied a mutation — the commands they interrupt
      // were refused with a 404 before doing anything.
      return new HttpsError("unavailable", error.userMessage);
    default:
      return new HttpsError("failed-precondition", error.userMessage);
    }
  }

  if (isRegistryError(error)) {
    logger.error(`${context} failed`, error.toLogPayload());
    switch (error.kind) {
    case "objectExists":
      return new HttpsError(
        "already-exists",
        context === "createHost" ?
          "このホスト名は既に登録されています。" :
          "このドメインは既に登録されています。",
      );
    case "objectNotFound":
      return new HttpsError(
        "not-found",
        "対象がレジストリに見つかりませんでした。",
      );
    case "validation":
    case "policyViolation":
      return new HttpsError(
        "invalid-argument",
        "レジストリに受け付けられない内容が含まれています。",
      );
    case "authFailed":
      // 2202 — an authInfo the caller supplied did not match. The transfer
      // use case normally catches this first and words it for the wizard;
      // this is the fallback for any other command that carries an authInfo,
      // and it must not look like a server fault (spec 6.7).
      return new HttpsError(
        "invalid-argument",
        "認証コード（AuthCode）が一致しませんでした。",
      );
    case "unauthorized":
      return new HttpsError(
        "internal",
        "レジストリへの接続設定に問題があります。",
      );
    case "forbidden":
      return new HttpsError(
        "permission-denied",
        "このドメインに対する操作は許可されていません。",
      );
    case "statusProhibited":
      return new HttpsError(
        "failed-precondition",
        "現在の状態ではこの操作を行えません。",
      );
    case "serviceUnavailable":
      // Announced maintenance is the one failure allowed to say so: the
      // registry itself said it over the poll queue, so this is not an
      // inference from a 503 (registryMaintenance.ts).
      if (error.maintenance) {
        return new HttpsError(
          "unavailable",
          "レジストリがメンテナンス中のため、現在この操作を行えません。",
          {
            reason: "registry-maintenance",
            registry: error.registry,
            until: error.maintenanceUntil,
          },
        );
      }
      // 503 = the command did not run (docs/仕様/registry-unavailable.md).
      // The `registry-unavailable` marker — which lets the client claim
      // "一時的に購入できません" — is attached ONLY once the circuit breaker
      // has judged the outage sustained; a fresh 503 stays a plain
      // could-not-reach answer, indistinguishable from `transport` below.
      return new HttpsError(
        "unavailable",
        "レジストリに接続できない状態です。しばらく時間をおいてから再度お試しください。",
        error.circuitOpen ?
          {reason: "registry-unavailable", registry: error.registry} :
          undefined,
      );
    case "transport":
      return new HttpsError(
        "unavailable",
        "レジストリに接続できませんでした。時間をおいて再度お試しください。",
      );
    default:
      return new HttpsError("internal", "処理できませんでした。");
    }
  }

  logger.error(`${context} failed`, {error: String(error)});
  return new HttpsError("internal", "処理できませんでした。");
}
