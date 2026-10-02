/**
 * The shared HTTP client every registry command goes through (spec 4.4).
 *
 * Responsibilities, in order:
 *   1. attach the Basic gate and the `X-Registrar-Id` / `X-Api-Key` headers
 *   2. attach `X-Cl-TRID`
 *   3. judge the outcome in two stages: HTTP status *and* `result.code`
 *   4. write a RegistryLog row with clTRID / svTRID / duration
 *   5. retry transport failures, and only for commands declared idempotent
 *
 * Nothing above the BRIDGE layer is allowed to call `fetch` directly. If this
 * class is bypassed once, the two-stage judgement and the audit trail are
 * silently lost for that call.
 */
import * as logger from "firebase-functions/logger";
import {
  REGISTRY_MAX_ATTEMPTS,
  registryTimeoutMs,
  resolveRegistryCredentials,
  type RegistryId,
} from "../config/options";
import {isForced503} from "../dev/force503Flag";
import {RegistryError, type RegistryErrorKind} from "./errors";
import {checkGate, record503, recordSuccess} from "./registryHealth";
import {
  checkMaintenanceGate,
  noteRegistryAnswered,
} from "./registryMaintenance";
import {writeRegistryLog} from "./registryLog";
import {EPP_RESULT, type EppEnvelope} from "./types";

/** Everything one registry command needs. */
export interface EppRequest {
  /** EPP command name, used for logs only (e.g. `domain:create`). */
  command: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path below `/api/v1/epp`, already URL-encoded. */
  path: string;
  body?: unknown;
  clTRID: string;
  /** Safe to re-send after a transport failure. Defaults to false. */
  idempotent?: boolean;
  /**
   * Result codes that must be handed back to the caller instead of raising.
   * `domain:create` passes 2302 so it can run the recovery check (spec 6.7).
   */
  tolerate?: number[];
  uid?: string;
  orderId?: string;
}

/** A registry answer that passed the two-stage judgement. */
export interface EppSuccess<T> {
  httpStatus: number;
  resultCode: number;
  resData?: T;
  extension?: Record<string, unknown>;
  clTRID: string;
  svTRID: string;
  /** True when the code was tolerated rather than a success code. */
  tolerated: boolean;
}

const SUCCESS_CODES: number[] = [
  EPP_RESULT.SUCCESS,
  EPP_RESULT.SUCCESS_ACTION_PENDING,
];

/**
 * Maps a failed answer onto a caller-facing error kind.
 *
 * @param {number | undefined} httpStatus Transport status, if we got one.
 * @param {number | undefined} resultCode Business result code, if we got one.
 * @return {RegistryErrorKind} How the caller should treat the failure.
 */
function classify(
  httpStatus: number | undefined,
  resultCode: number | undefined,
): RegistryErrorKind {
  if (resultCode === EPP_RESULT.OBJECT_EXISTS) return "objectExists";
  if (resultCode === EPP_RESULT.OBJECT_DOES_NOT_EXIST) return "objectNotFound";
  if (resultCode === EPP_RESULT.AUTH_ERROR) return "authFailed";
  if (resultCode === EPP_RESULT.POLICY_VIOLATION) return "policyViolation";
  if (resultCode === EPP_RESULT.STATUS_PROHIBITS_OPERATION) {
    return "statusProhibited";
  }
  if (httpStatus === undefined) return "transport";
  // 401 means our credentials were refused; 403 means they were accepted and
  // this registrar simply may not touch the object. Collapsing the two would
  // report "restore someone else's domain" as a configuration problem.
  if (httpStatus === 401) return "unauthorized";
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 404) return "objectNotFound";
  if (httpStatus === 409) return "objectExists";
  if (httpStatus === 400 || httpStatus === 422) return "validation";
  // 503 = the request was rejected unprocessed. Whether that is a blip or a
  // sustained outage is judged across requests by registryHealth.ts
  // (docs/仕様/registry-unavailable.md).
  if (httpStatus === 503) return "serviceUnavailable";
  if (httpStatus >= 500) return "transport";
  return "unknown";
}

/**
 * Reads the human-readable text out of a `result` block, tolerating both the
 * schema field name (`message`) and the one used in the prose examples
 * (`msg`).
 *
 * @param {EppEnvelope<unknown> | undefined} envelope Parsed answer.
 * @return {string} Message text, or a placeholder.
 */
function resultText(envelope: EppEnvelope<unknown> | undefined): string {
  const result = envelope?.result;
  return result?.message ?? result?.msg ?? "no result message";
}

/**
 * Sleeps, used for the retry backoff.
 *
 * @param {number} ms Milliseconds to wait.
 * @return {Promise<void>} Resolves once the delay elapsed.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP client bound to a single registry. */
export class EppClient {
  readonly registry: RegistryId;

  /**
   * @param {RegistryId} registry Registry this client talks to.
   */
  constructor(registry: RegistryId) {
    this.registry = registry;
  }

  /**
   * Issues one registry command and judges the answer in two stages.
   *
   * @param {EppRequest} request Command to run.
   * @return {Promise<EppSuccess<T>>} The accepted answer.
   */
  async send<T>(request: EppRequest): Promise<EppSuccess<T>> {
    // Announced maintenance beats the inferred judgement below: inside the
    // window there is nothing to probe for, so fail fast without connecting
    // at all (registryMaintenance.ts).
    const maintenanceGate = await checkMaintenanceGate(this.registry);
    if (maintenanceGate.decision === "blocked") {
      await writeRegistryLog({
        registry: this.registry,
        command: request.command,
        method: request.method,
        path: request.path,
        clTRID: request.clTRID,
        svTRID: null,
        httpStatus: null,
        resultCode: null,
        durationMs: 0,
        ok: false,
        errorKind: "serviceUnavailable",
        errorMessage: "maintenance window: skipped (registry announced " +
          `maintenance${maintenanceGate.until ?
            ` until ${maintenanceGate.until}` : ""})`,
        uid: request.uid ?? null,
        orderId: request.orderId ?? null,
      });
      throw new RegistryError({
        kind: "serviceUnavailable",
        registry: this.registry,
        command: request.command,
        message: `${request.command} skipped: registry announced maintenance`,
        clTRID: request.clTRID,
        retryable: false,
        maintenance: true,
        maintenanceUntil: maintenanceGate.until,
      });
    }

    // Circuit breaker (docs/仕様/registry-unavailable.md): once the registry
    // has been judged unreachable, fail fast instead of hammering it — except
    // for the periodic probe that lets a recovery close the circuit again.
    const gate = await checkGate(this.registry);
    if (gate === "open") {
      await writeRegistryLog({
        registry: this.registry,
        command: request.command,
        method: request.method,
        path: request.path,
        clTRID: request.clTRID,
        svTRID: null,
        httpStatus: null,
        resultCode: null,
        durationMs: 0,
        ok: false,
        errorKind: "serviceUnavailable",
        errorMessage: "circuit open: skipped (registry judged unreachable)",
        uid: request.uid ?? null,
        orderId: request.orderId ?? null,
      });
      throw new RegistryError({
        kind: "serviceUnavailable",
        registry: this.registry,
        command: request.command,
        message: `${request.command} skipped: registry judged unreachable ` +
          "(circuit open)",
        clTRID: request.clTRID,
        retryable: false,
        circuitOpen: true,
      });
    }

    const maxAttempts = request.idempotent ? REGISTRY_MAX_ATTEMPTS : 1;
    let lastError: RegistryError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(request);
      } catch (error) {
        if (!(error instanceof RegistryError) || !error.retryable) {
          throw error;
        }
        lastError = error;
        if (attempt < maxAttempts) {
          const backoffMs = 250 * 2 ** (attempt - 1);
          logger.warn("retrying registry command", {
            registry: this.registry,
            command: request.command,
            clTRID: request.clTRID,
            attempt,
            backoffMs,
          });
          await sleep(backoffMs);
        }
      }
    }
    throw lastError;
  }

  /**
   * Runs exactly one HTTP attempt, logs it, and either returns the accepted
   * answer or throws a fully classified RegistryError.
   *
   * @param {EppRequest} request Command to run.
   * @return {Promise<EppSuccess<T>>} The accepted answer.
   */
  private async attempt<T>(request: EppRequest): Promise<EppSuccess<T>> {
    const credentials = resolveRegistryCredentials(this.registry);
    const url = `${credentials.baseUrl}/api/v1/epp${request.path}`;
    const basic = Buffer.from(
      `${credentials.gateUser}:${credentials.gatePassword}`,
    ).toString("base64");

    const headers: Record<string, string> = {
      Authorization: `Basic ${basic}`,
      "X-Registrar-Id": credentials.registrarId,
      "X-Api-Key": credentials.apiKey,
      "X-Cl-TRID": request.clTRID,
      Accept: "application/json",
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const startedAt = Date.now();

    let httpStatus: number | undefined;
    let envelope: EppEnvelope<T> | undefined;
    let transportMessage: string | undefined;

    if (await isForced503(this.registry)) {
      // Emulator-only fault injection (dev panel). Synthesising the status
      // here — not throwing — keeps the two-stage judgement, RegistryLog and
      // registryHealth on their real code paths.
      httpStatus = 503;
      transportMessage = "simulated 503 (dev switch)";
    } else {
      // The fetch must give up before the surrounding function does,
      // otherwise the caller can never report "retrying" to the UI (FIG.2).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), registryTimeoutMs());
      try {
        const response = await fetch(url, {
          method: request.method,
          headers,
          body:
            request.body === undefined ?
              undefined :
              JSON.stringify(request.body),
          signal: controller.signal,
        });
        httpStatus = response.status;
        const text = await response.text();
        if (text) {
          try {
            envelope = JSON.parse(text) as EppEnvelope<T>;
          } catch {
            transportMessage = `non-JSON body: ${text.slice(0, 200)}`;
          }
        }
      } catch (error) {
        transportMessage =
          error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
    }

    const durationMs = Date.now() - startedAt;
    const resultCode = envelope?.result?.code;
    const svTRID = envelope?.trID?.svTRID;

    const transportOk =
      httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300;
    const tolerated =
      resultCode !== undefined &&
      (request.tolerate ?? []).includes(resultCode);
    const ok =
      envelope !== undefined &&
      resultCode !== undefined &&
      (SUCCESS_CODES.includes(resultCode) || tolerated) &&
      (transportOk || tolerated);

    await writeRegistryLog({
      registry: this.registry,
      command: request.command,
      method: request.method,
      path: request.path,
      clTRID: request.clTRID,
      svTRID: svTRID ?? null,
      httpStatus: httpStatus ?? null,
      resultCode: resultCode ?? null,
      durationMs,
      ok,
      errorKind: ok ? null : classify(httpStatus, resultCode),
      errorMessage: ok ? null : transportMessage ?? resultText(envelope),
      uid: request.uid ?? null,
      orderId: request.orderId ?? null,
    });

    if (ok) {
      await recordSuccess(this.registry);
      // A real answer past the announced window is what retires a standing
      // maintenance record ("疎通を確認してから解除").
      await noteRegistryAnswered(this.registry);
      return {
        httpStatus: httpStatus as number,
        resultCode: resultCode as number,
        resData: envelope?.resData,
        extension: envelope?.extension,
        clTRID: request.clTRID,
        svTRID: svTRID ?? "",
        tolerated,
      };
    }

    // Health judgement: a 503 counts against the registry; any other
    // ANSWERED status — a business 4xx included — proves it is reachable and
    // resets the streak. Pure network failures (no status at all) stay out
    // of scope for now.
    let circuitOpen = false;
    if (httpStatus === 503) {
      circuitOpen = (await record503(this.registry)).circuitOpen;
    } else if (httpStatus !== undefined) {
      await recordSuccess(this.registry);
      await noteRegistryAnswered(this.registry);
    }

    const kind = classify(httpStatus, resultCode);
    throw new RegistryError({
      kind,
      registry: this.registry,
      command: request.command,
      message:
        transportMessage ??
        `${request.command} failed: HTTP ${httpStatus} / ` +
          `result ${resultCode} (${resultText(envelope)})`,
      httpStatus,
      resultCode,
      clTRID: request.clTRID,
      svTRID,
      retryable: kind === "transport" || kind === "serviceUnavailable",
      circuitOpen,
    });
  }
}
