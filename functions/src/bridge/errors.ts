/**
 * The single error type the BRIDGE layer throws.
 *
 * Everything the caller needs in order to decide "retry / recover / give up"
 * is on this object, so no layer above BRIDGE ever has to look at an HTTP
 * status and a `result.code` again (spec 3.3, 4.4).
 */
import type {RegistryId} from "../config/options";

/** Why a registry call failed, from the caller's point of view. */
export type RegistryErrorKind =
  /**
   * Network failure, timeout or a 5xx other than 503: the command may or may
   * not have run.
   */
  | "transport"
  /**
   * HTTP 503 — the registry answered "Service Unavailable" (overload,
   * restart, maintenance — the cause is NOT knowable from one answer, see
   * docs/仕様/registry-unavailable.md). Unlike `transport`, the request was
   * rejected at the gate, so the command is known NOT to have run and an
   * in-request retry is safe. Whether this is a blip or a sustained outage
   * is judged ACROSS requests by registryHealth.ts — see `circuitOpen`.
   */
  | "serviceUnavailable"
  /** The registry rejected the request body (HTTP 400 / 422). */
  | "validation"
  /** `result.code` 2302 — the object already exists. */
  | "objectExists"
  /** `result.code` 2303 or HTTP 404 — the object does not exist. */
  | "objectNotFound"
  /** `result.code` 2202 — authInfo mismatch. */
  | "authFailed"
  /** `result.code` 2306 — registry policy violation. */
  | "policyViolation"
  /**
   * `result.code` 2304 — the object exists but its current status forbids
   * the command, e.g. restoring a domain that is not pendingDelete.
   */
  | "statusProhibited"
  /**
   * HTTP 403 — we authenticated fine, but this registrar may not touch this
   * object. `domain:restore` answers this when we are not the sponsoring
   * registrar. Distinct from `unauthorized`, which means our credentials
   * themselves were rejected.
   */
  | "forbidden"
  /** Authenticated as nobody: Basic gate or API key rejected. */
  | "unauthorized"
  /** Anything the two-stage check could not classify. */
  | "unknown";

/** Error raised by the BRIDGE layer for every failed registry command. */
export class RegistryError extends Error {
  readonly kind: RegistryErrorKind;
  readonly registry: RegistryId;
  readonly command: string;
  readonly httpStatus?: number;
  readonly resultCode?: number;
  readonly clTRID: string;
  readonly svTRID?: string;
  /** True when re-issuing the same clTRID is safe and worth trying. */
  readonly retryable: boolean;
  /**
   * Set with kind `serviceUnavailable` once registryHealth has judged the
   * registry unreachable (503s sustained for ~1 minute). Only then may the
   * UI claim "一時的に購入できません"; a fresh 503 without this flag is an
   * ordinary could-not-check failure (docs/仕様/registry-unavailable.md).
   */
  readonly circuitOpen: boolean;
  /**
   * Set with kind `serviceUnavailable` when the registry itself announced a
   * maintenance window over the poll queue and the command fell inside it
   * (registryMaintenance.ts). This is the ONE signal strong enough for the
   * UI to claim "メンテナンス中" — a 503 alone never is.
   */
  readonly maintenance: boolean;
  /** Announced end of the window (ISO 8601), when the registry gave one. */
  readonly maintenanceUntil: string | null;

  /**
   * @param {object} init Fully classified failure.
   */
  constructor(init: {
    kind: RegistryErrorKind;
    registry: RegistryId;
    command: string;
    message: string;
    httpStatus?: number;
    resultCode?: number;
    clTRID: string;
    svTRID?: string;
    retryable?: boolean;
    circuitOpen?: boolean;
    maintenance?: boolean;
    maintenanceUntil?: string | null;
  }) {
    super(init.message);
    this.name = "RegistryError";
    this.kind = init.kind;
    this.registry = init.registry;
    this.command = init.command;
    this.httpStatus = init.httpStatus;
    this.resultCode = init.resultCode;
    this.clTRID = init.clTRID;
    this.svTRID = init.svTRID;
    this.retryable = init.retryable ??
      (init.kind === "transport" || init.kind === "serviceUnavailable");
    this.circuitOpen = init.circuitOpen ?? false;
    this.maintenance = init.maintenance ?? false;
    this.maintenanceUntil = init.maintenanceUntil ?? null;
  }

  /**
   * Compact representation for logs and for the `error` field of an Order.
   *
   * @return {object} Plain object safe to write to Firestore.
   */
  toLogPayload(): Record<string, unknown> {
    return {
      kind: this.kind,
      registry: this.registry,
      command: this.command,
      message: this.message,
      httpStatus: this.httpStatus ?? null,
      resultCode: this.resultCode ?? null,
      clTRID: this.clTRID,
      svTRID: this.svTRID ?? null,
      retryable: this.retryable,
      circuitOpen: this.circuitOpen,
      maintenance: this.maintenance,
      maintenanceUntil: this.maintenanceUntil,
    };
  }
}

/**
 * Narrows an unknown thrown value to a RegistryError.
 *
 * @param {unknown} error Value caught in a `catch` block.
 * @return {boolean} True when the value is a RegistryError.
 */
export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}
