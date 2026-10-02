/**
 * The transfer use cases (spec 6.6) — the member-driven half.
 *
 *   移管IN  (we are gaining): requestIncomingTransfer -> cancelIncomingTransfer
 *   移管OUT (we are losing):  respondToOutgoingTransfer(approve | reject)
 *
 * The asynchronous half — the registry telling us a transfer was requested on
 * one of our domains, or that a request of ours was approved — arrives through
 * the poll queue and lives in `transferNotifications.ts`.
 *
 * Three properties shape everything here.
 *
 * **A transfer command is never auto-retried.** `EppClient` only retries what
 * the BRIDGE layer declares idempotent, and none of the four transfer
 * commands is: re-sending `request` could raise a second transfer, and
 * re-sending `approve` could hand away a domain the member has since decided
 * to keep. An ambiguous outcome is therefore reconciled against
 * `domain:info`, exactly as `renewDomain.ts` reconciles an ambiguous renewal.
 *
 * **`domain:info` may not be readable.** For a transfer-in the domain belongs
 * to somebody else until the moment it does not, and whether a non-sponsoring
 * registrar may read it is explicitly unverified (spec TBD #16). So
 * reconciliation here is a three-way probe — readable / absent / unreadable —
 * and "unreadable" is reported as such instead of being guessed at.
 *
 * **The other registrar owns the ending.** We can request, cancel, approve or
 * reject; we cannot decide. A transfer that is `pending` stays `pending` until
 * a poll notification (or the registry's 20-minute auto-approve) moves it,
 * which is why the record's state machine has no `retrying` (spec 6.6.1).
 */
import * as logger from "firebase-functions/logger";
import {FieldValue} from "firebase-admin/firestore";
import {isRegistryError} from "../bridge/errors";
import {getRegistryClient, resolveRegistry} from "../bridge/registryRouter";
import type {RegistryClient} from "../bridge/registryClient";
import type {DomainInfo} from "../bridge/types";
import type {RegistryId} from "../config/options";
import {adhocClTrid, domainClTrid} from "./clTrid";
import {
  DomainNotOwnedError,
  loadOwnedDomain,
  syncDomainRecord,
} from "./domainRecords";
import {assertOwnsDomain} from "./ownership";
import {ValidationError} from "./validation";
import {
  autoApproveDeadline,
  claimTransfer,
  listTransfers,
  loadTransfer,
  releaseTransferClaim,
  settleTransfer,
  type TransferDirection,
  type TransferRecord,
  type TransferState,
} from "./transfers";

/** The EPP status a domain carries while a transfer is outstanding. */
const PENDING_TRANSFER_STATUS = "pendingTransfer";

/** Why a transfer command cannot proceed, in terms the API layer can map. */
export type TransferFailureReason =
  /** 2202 / HTTP 401 on `request`: the pasted AuthCode does not match. */
  | "authInfoMismatch"
  /** The member already holds this domain with us. */
  | "alreadyOurs"
  /** Another invocation is mid-flight on the same transfer. */
  | "busy"
  /** There is no outstanding transfer to act on. */
  | "notPending"
  /** The registry refused: locked, wrong status, or not ours to touch. */
  | "refused"
  /**
   * The registry is temporarily unreachable — a real outage or the circuit
   * breaker skipping the command. Nothing was sent (or nothing landed), so
   * retrying later is safe and is the right advice.
   */
  | "registryDown"
  /** Neither success nor failure could be proven. */
  | "indeterminate";

/** A transfer command that could not be carried out, with a reason to show. */
export class TransferError extends Error {
  readonly reason: TransferFailureReason;
  readonly userMessage: string;

  /**
   * @param {TransferFailureReason} reason Why it cannot proceed.
   * @param {string} userMessage Text the screen may show as-is.
   */
  constructor(reason: TransferFailureReason, userMessage: string) {
    super(userMessage);
    this.name = "TransferError";
    this.reason = reason;
    this.userMessage = userMessage;
  }
}

/** What one transfer command ended up doing, shaped for the Callable. */
export interface TransferResult {
  domainName: string;
  registry: RegistryId;
  direction: TransferDirection;
  state: TransferState;
  gainingRegistrar: string | null;
  losingRegistrar: string | null;
  /** ISO 8601. */
  requestedAt: string | null;
  /** ISO 8601 — after this the registry approves by itself (spec 6.6.1). */
  autoApproveAt: string | null;
  /** True when `domain:info` proved the outcome rather than the command. */
  recovered: boolean;
  /** Message intended for the UI, already in Japanese. */
  message: string;
}

/** The four commands, as they appear in a clTRID and in logs. */
type TransferOperation = "request" | "approve" | "reject" | "cancel";

/** What a `domain:info` probe could establish. */
type DomainProbe =
  | {kind: "info"; info: DomainInfo}
  /** The registry says there is no such domain. */
  | {kind: "absent"}
  /** We are not allowed to look, or the read itself failed. */
  | {kind: "unreadable"};

/**
 * Builds a unique-enough suffix for a domain-scoped clTRID, matching the way
 * `domainLifecycle.ts` stamps delete and restore.
 *
 * @return {string} Short base36 stamp.
 */
function stamp(): string {
  return Date.now().toString(36);
}

/**
 * clTRID for one transfer command, e.g. `DOM-TRANSFER-EXAMPLE-COM-REQUEST-…`.
 *
 * @param {TransferOperation} operation Command being issued.
 * @param {string} domainName Domain the command acts on.
 * @return {string} clTRID for the `X-Cl-TRID` header.
 */
function transferClTrid(
  operation: TransferOperation,
  domainName: string,
): string {
  return domainClTrid("TRANSFER", domainName, `${operation}-${stamp()}`);
}

/**
 * Reads `domain:info` without letting "not there" or "not allowed" become an
 * exception, so a reconciliation can tell the three cases apart.
 *
 * @param {RegistryClient} client Registry to ask.
 * @param {string} domainName Domain to look up.
 * @return {Promise<DomainProbe>} What could be established.
 */
async function probeDomain(
  client: RegistryClient,
  domainName: string,
): Promise<DomainProbe> {
  try {
    const info = await client.infoDomain(
      domainName,
      domainClTrid("INFO", domainName, stamp()),
    );
    return {kind: "info", info};
  } catch (error) {
    if (!isRegistryError(error)) return {kind: "unreadable"};
    if (error.kind === "objectNotFound") return {kind: "absent"};
    // 403 here is not a failure to report: a gaining registrar simply may not
    // read a domain it does not sponsor yet (spec TBD #16).
    return {kind: "unreadable"};
  }
}

/**
 * Turns a stored record into the Callable's answer.
 *
 * @param {TransferRecord} record Record to describe.
 * @param {string} message Japanese text for the screen.
 * @param {boolean} recovered Whether `domain:info` proved the outcome.
 * @return {TransferResult} Response payload.
 */
function toResult(
  record: TransferRecord,
  message: string,
  recovered = false,
): TransferResult {
  const {data} = record;
  return {
    domainName: data.domainName,
    registry: data.registry,
    direction: data.direction,
    state: data.state,
    gainingRegistrar: data.gainingRegistrar,
    losingRegistrar: data.losingRegistrar,
    requestedAt: data.requestedAt,
    autoApproveAt: data.autoApproveAt,
    recovered,
    message,
  };
}

/** Japanese wording for a transfer that is waiting on the other registrar. */
const PENDING_MESSAGE =
  "移管を申請しました。移管元レジストラの承認をお待ちください。";

/**
 * Maps a registry rejection that is final — the command definitely did not
 * take effect — onto the reason and wording the screen should show.
 *
 * @param {TransferOperation} operation Command that was rejected.
 * @param {string} kind RegistryError kind.
 * @return {TransferError} Error carrying a client-safe Japanese message.
 */
function refusal(
  operation: TransferOperation,
  kind: string,
): TransferError {
  if (kind === "authFailed") {
    // Spec 6.7's mapping table: 2202 is the one error the transfer-in wizard
    // must explain properly, because it is the step members get wrong.
    return new TransferError(
      "authInfoMismatch",
      "認証コード（AuthCode）が違うようです。移管元の管理画面でもう一度ご確認ください。",
    );
  }
  if (kind === "objectNotFound") {
    return operation === "request" ?
      new TransferError(
        "refused",
        "そのドメインはレジストリに登録されていません。ドメイン名をご確認ください。",
      ) :
      new TransferError(
        "notPending",
        "対象の移管申請が見つかりませんでした。すでに処理済みの可能性があります。",
      );
  }
  if (kind === "objectExists" || kind === "statusProhibited") {
    // 409 / 2304. On `request` this is "a transfer is already outstanding";
    // on the others it is "there is nothing to act on any more".
    return operation === "request" ?
      new TransferError(
        "notPending",
        "このドメインにはすでに移管申請が出ています。しばらくしてから状態をご確認ください。",
      ) :
      new TransferError(
        "notPending",
        "この移管申請はすでに処理されています。最新の状態をご確認ください。",
      );
  }
  if (kind === "forbidden") {
    return new TransferError(
      "refused",
      "このドメインに対する移管操作は許可されていません。",
    );
  }
  if (kind === "validation" || kind === "policyViolation") {
    return new TransferError(
      "refused",
      "レジストリに受け付けられない内容が含まれています。",
    );
  }
  if (kind === "serviceUnavailable" || kind === "transport") {
    // The command did not land (503 outage, timeout, or the circuit breaker
    // answering locally). "移管処理を完了できませんでした [403]" here would
    // read as a permission problem and stop the member from retrying — the
    // one thing that actually helps.
    return new TransferError(
      "registryDown",
      "レジストリが一時的に不安定です。しばらくしてから再度お試しください。",
    );
  }
  return new TransferError("refused", "移管処理を完了できませんでした。");
}

/**
 * Decides what an ambiguous transfer command actually did, by asking
 * `domain:info` whether the domain now carries `pendingTransfer`.
 *
 * Each operation has its own tell:
 *
 * | operation | landed                       | did not land           |
 * |-----------|------------------------------|------------------------|
 * | request   | `pendingTransfer` present    | absent                 |
 * | cancel    | `pendingTransfer` gone       | still present          |
 * | reject    | `pendingTransfer` gone       | still present          |
 * | approve   | unreadable / absent for us   | still present          |
 *
 * ⚠️ `pendingTransfer` does not say *whose* request it is; the registry does
 * not expose the gaining registrar on `domain:info`. It is read as ours only
 * because this invocation just sent a request for that exact domain moments
 * earlier. The cost of being wrong is a transfer shown as pending that is
 * actually somebody else's — visible and recoverable — whereas the
 * alternative (re-sending) risks a second live transfer request.
 *
 * @param {TransferOperation} operation Command whose outcome is unknown.
 * @param {RegistryClient} client Registry to ask.
 * @param {string} domainName Domain in question.
 * @return {Promise<"landed" | "did-not-land" | "unknown">} What the probe
 *   could prove.
 */
async function reconcileTransfer(
  operation: TransferOperation,
  client: RegistryClient,
  domainName: string,
): Promise<"landed" | "did-not-land" | "unknown"> {
  const probe = await probeDomain(client, domainName);

  if (probe.kind === "absent") {
    // Nothing to transfer, or (for approve) nothing we can still see.
    return operation === "approve" ? "landed" : "did-not-land";
  }
  if (probe.kind === "unreadable") {
    // Tempting to read "we can no longer see it" as "the approve worked", but
    // a non-sponsoring registrar may be refused `domain:info` for reasons
    // that have nothing to do with this command (spec TBD #16), so this stays
    // honestly unknown rather than being guessed at.
    return "unknown";
  }

  const pending = probe.info.status.includes(PENDING_TRANSFER_STATUS);
  if (operation === "request") return pending ? "landed" : "did-not-land";
  return pending ? "did-not-land" : "landed";
}

/**
 * Turns a failed transfer command into a settled record plus a thrown
 * `TransferError`, reconciling first when the failure was ambiguous.
 *
 * Only `transport` and `unknown` failures are reconciled; a registry-issued
 * rejection is final and is reported as such, exactly like `renewDomain.ts`
 * splits ambiguous from decided failures.
 *
 * @param {TransferOperation} operation Command that failed.
 * @param {TransferRecord} record Record being acted on.
 * @param {string} token This invocation's claim token.
 * @param {RegistryClient} client Registry the command went to.
 * @param {unknown} error Whatever was thrown.
 * @param {TransferState} landedState State to write when the probe proves the
 *   command did take effect.
 * @return {Promise<TransferResult>} A recovered result; otherwise it throws.
 */
async function handleTransferFailure(
  operation: TransferOperation,
  record: TransferRecord,
  token: string,
  client: RegistryClient,
  error: unknown,
  landedState: TransferState,
): Promise<TransferResult> {
  const payload = isRegistryError(error) ?
    error.toLogPayload() :
    {kind: "unknown", message: String(error)};
  logger.error("transfer command failed", {
    operation,
    domainName: record.data.domainName,
    ...payload,
  });

  const kind = isRegistryError(error) ? error.kind : "unknown";

  // Kitaqnic documents HTTP 401 on `transfer/request` as "Invalid authInfo",
  // and this service's credentials are the same headers every other command
  // already authenticated with, so on this one endpoint a 401 is read as a
  // wrong AuthCode rather than as a broken configuration — the alternative
  // shows the member "レジストリへの接続設定に問題があります" for a typo they
  // could fix in five seconds (spec 6.7). Logged loudly, because the two are
  // genuinely indistinguishable on the wire.
  if (
    operation === "request" &&
    kind === "unauthorized" &&
    isRegistryError(error) &&
    error.httpStatus === 401
  ) {
    logger.error(
      "transfer/request answered 401; treating it as a wrong AuthCode",
      {domainName: record.data.domainName},
    );
    await settleTransfer(record, token, {state: "failed", error: payload});
    throw refusal(operation, "authFailed");
  }

  if (kind !== "transport" && kind !== "unknown") {
    await settleTransfer(record, token, {state: "failed", error: payload});
    throw refusal(operation, kind);
  }

  const verdict = await reconcileTransfer(
    operation,
    client,
    record.data.domainName,
  );

  if (verdict === "landed") {
    const requestedAt = record.data.requestedAt ?? new Date().toISOString();
    await settleTransfer(record, token, {
      state: landedState,
      error: null,
      ...(landedState === "pending" ?
        {requestedAt, autoApproveAt: autoApproveDeadline(requestedAt)} :
        {}),
    });
    return toResult(
      record,
      landedState === "pending" ?
        PENDING_MESSAGE :
        "移管処理を受け付けました。",
      true,
    );
  }

  if (verdict === "did-not-land") {
    await settleTransfer(record, token, {state: "failed", error: payload});
    throw new TransferError(
      "refused",
      "レジストリに接続できず、処理は行われませんでした。時間をおいて再度お試しください。",
    );
  }

  // Neither provable. The claim is released so the same member can try again
  // once the registry recovers, but the record's state is left untouched:
  // writing "failed" here would tell the member nothing happened when it
  // might well have.
  await releaseTransferClaim(record, token);
  throw new TransferError(
    "indeterminate",
    "移管の結果を確認できませんでした。しばらくしてから最新の状態をご確認ください。",
  );
}

/**
 * 移管IN — asks the registry to move a domain the member holds elsewhere over
 * to this service, proving the claim with the AuthCode (spec 6.6.2).
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain to bring in, already normalised.
 * @param {string} authInfo Transfer passphrase issued by the losing side.
 * @return {Promise<TransferResult>} What the screen should show next.
 */
export async function requestIncomingTransfer(
  uid: string,
  domainName: string,
  authInfo: string,
): Promise<TransferResult> {
  const registry = await resolveRegistry(
    domainName,
    adhocClTrid("TLD", uid.slice(0, 12)),
  );
  if (!registry) {
    throw new ValidationError(
      "domainName",
      "このドメインのTLDは当サービスでは取り扱っていません。",
    );
  }

  // A domain the caller already holds here cannot be transferred in: the
  // gaining and losing registrar would be the same. Checked against the
  // caller's own mirror document only — never a cross-member lookup, which
  // would let one member probe what another member holds (spec 7.3).
  await assertNotAlreadyOwned(uid, domainName);

  const claim = await claimTransfer({
    uid,
    domainName,
    registry,
    direction: "in",
    // Every settled state may be restarted — including `completed`, which by
    // now can only describe an *earlier* transfer, since the ownership check
    // above has just established the member does not hold this domain (they
    // transferred it away again, or it expired). Only `pending` is excluded:
    // a live request must never be raised twice.
    allowedStates: ["rejected", "cancelled", "failed", "completed"],
    openIfMissing: true,
  });

  if (claim.status === "busy") {
    throw new TransferError(
      "busy",
      "この移管はただいま処理中です。しばらくしてから再度お試しください。",
    );
  }
  if (claim.status === "missing") {
    // Unreachable: openIfMissing is true. Kept so the union stays exhaustive.
    throw new TransferError("indeterminate", "移管申請を開始できませんでした。");
  }
  if (claim.status === "wrongState") {
    // The only excluded state is `pending`: a re-submitted form. Answer with
    // the request already in flight rather than raising a second one.
    return toResult(claim.record, PENDING_MESSAGE);
  }

  const {record, token} = claim;
  const client = getRegistryClient(registry);

  try {
    const outcome = await client.requestTransfer(
      domainName,
      {op: "request", authInfo},
      transferClTrid("request", domainName),
      {uid},
    );
    // Our own clock, not `outcome.requestedAt`: kitaqsign spells it without
    // a zone and kitaqnic labels JST as `Z`, so the registry's value can put
    // the 20-minute deadline nine hours out. The command has just returned,
    // so "now" is within a second of the truth.
    const requestedAt = new Date().toISOString();
    await settleTransfer(record, token, {
      state: "pending",
      gainingRegistrar: outcome.gainingRegistrar,
      losingRegistrar: outcome.losingRegistrar,
      requestedAt,
      autoApproveAt: autoApproveDeadline(requestedAt),
      error: null,
    });
    return toResult(record, PENDING_MESSAGE);
  } catch (error) {
    return handleTransferFailure(
      "request",
      record,
      token,
      client,
      error,
      "pending",
    );
  }
}

/**
 * 移管IN の取消 — withdraws a request of ours before the losing registrar
 * has acted on it.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain whose request should be withdrawn.
 * @return {Promise<TransferResult>} What the screen should show next.
 */
export async function cancelIncomingTransfer(
  uid: string,
  domainName: string,
): Promise<TransferResult> {
  // Read first purely to learn which registry the transfer lives on. The
  // claim below re-reads inside its transaction and keeps the stored registry
  // regardless, so this cannot go stale in a way that matters — it just keeps
  // a placeholder registry out of the call.
  const existing = await loadTransfer(uid, domainName);
  if (!existing) {
    throw new TransferError(
      "notPending",
      "取り消せる移管申請が見つかりませんでした。",
    );
  }

  const claim = await claimTransfer({
    uid,
    domainName,
    registry: existing.data.registry,
    direction: "in",
    allowedStates: ["pending"],
    // Cancelling belongs to the gaining side; a request somebody made for one
    // of *our* domains is never withdrawable by us (spec 6.6.1).
    expectDirection: "in",
    openIfMissing: false,
  });

  if (claim.status === "missing") {
    throw new TransferError(
      "notPending",
      "取り消せる移管申請が見つかりませんでした。",
    );
  }
  if (claim.status === "busy") {
    throw new TransferError(
      "busy",
      "この移管はただいま処理中です。しばらくしてから再度お試しください。",
    );
  }
  if (claim.status === "wrongState") {
    throw new TransferError(
      "notPending",
      "この移管申請は取り消せません。最新の状態をご確認ください。",
    );
  }

  const {record, token} = claim;
  const client = getRegistryClient(record.data.registry);
  try {
    const outcome = await client.cancelTransfer(
      domainName,
      transferClTrid("cancel", domainName),
      {uid},
    );
    await settleTransfer(record, token, {
      state: "cancelled",
      gainingRegistrar: outcome.gainingRegistrar,
      losingRegistrar: outcome.losingRegistrar,
      error: null,
    });
    return toResult(record, "移管申請を取り消しました。");
  } catch (error) {
    return handleTransferFailure(
      "cancel",
      record,
      token,
      client,
      error,
      "cancelled",
    );
  }
}

/**
 * 移管OUT — the losing side's answer to a transfer request that landed on one
 * of the member's domains (FIG.3 下帯).
 *
 * Approving is irreversible and hands the domain to another registrar, so the
 * ownership check runs before anything else (spec 7.3).
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain being asked for, already normalised.
 * @param {"approve" | "reject"} action What the member decided.
 * @return {Promise<TransferResult>} What the screen should show next.
 */
export async function respondToOutgoingTransfer(
  uid: string,
  domainName: string,
  action: "approve" | "reject",
): Promise<TransferResult> {
  const owned = await assertOwnsDomain(uid, domainName);

  const claim = await claimTransfer({
    uid,
    domainName,
    registry: owned.registry,
    direction: "out",
    allowedStates: ["pending"],
    // Approving and rejecting belong to the losing side. A transfer *this*
    // member started must never be answerable through this path — the
    // registry would refuse it anyway (403), but the record must not be
    // moved to `completed` on the strength of a command we cannot issue.
    expectDirection: "out",
    openIfMissing: false,
  });

  if (claim.status === "missing") {
    throw new TransferError(
      "notPending",
      "対象の移管申請が見つかりませんでした。",
    );
  }
  if (claim.status === "busy") {
    throw new TransferError(
      "busy",
      "この移管はただいま処理中です。しばらくしてから再度お試しください。",
    );
  }
  if (claim.status === "wrongState") {
    throw new TransferError(
      "notPending",
      "この移管申請はすでに処理されています。最新の状態をご確認ください。",
    );
  }

  const {record, token} = claim;
  const client = getRegistryClient(owned.registry);
  const operation: TransferOperation =
    action === "approve" ? "approve" : "reject";

  try {
    const outcome = await (action === "approve" ?
      client.approveTransfer(
        domainName,
        transferClTrid("approve", domainName),
        {uid},
      ) :
      client.rejectTransfer(
        domainName,
        transferClTrid("reject", domainName),
        {uid},
      ));

    await settleTransfer(record, token, {
      state: action === "approve" ? "completed" : "rejected",
      gainingRegistrar: outcome.gainingRegistrar,
      losingRegistrar: outcome.losingRegistrar,
      error: null,
    });
    await syncAfterOutgoingDecision(uid, domainName, action, client);
    return toResult(
      record,
      action === "approve" ?
        "移管を承認しました。このドメインは移管先レジストラの管理になります。" :
        "移管申請を拒否しました。ドメインは引き続きご利用いただけます。",
    );
  } catch (error) {
    const result = await handleTransferFailure(
      operation,
      record,
      token,
      client,
      error,
      action === "approve" ? "completed" : "rejected",
    );
    // Only reached when reconciliation proved the command did land.
    await syncAfterOutgoingDecision(uid, domainName, action, client);
    return result;
  }
}

/**
 * Lists the transfer requests waiting on the member's decision (FIG.3 下帯),
 * plus the transfers the member started that are still outstanding.
 *
 * @param {string} uid Firebase Authentication uid.
 * @return {Promise<TransferResult[]>} Pending transfers, newest first.
 */
export async function listPendingTransfers(
  uid: string,
): Promise<TransferResult[]> {
  const records = await listTransfers(uid, {state: "pending"});
  return records.map((record) =>
    toResult(
      record,
      record.data.direction === "out" ?
        "移管申請が届いています。承認または拒否してください。" :
        PENDING_MESSAGE,
    ),
  );
}

/**
 * Reads one transfer, so a screen can poll for the other registrar's answer.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain being transferred.
 * @return {Promise<TransferResult | null>} The transfer, or null.
 */
export async function getTransfer(
  uid: string,
  domainName: string,
): Promise<TransferResult | null> {
  const record = await loadTransfer(uid, domainName);
  if (!record) return null;
  return toResult(record, describeState(record.data.state));
}

/**
 * Japanese one-liner for a stored state, used when no command just ran.
 *
 * @param {TransferState} state State to describe.
 * @return {string} Text the screen may show as-is.
 */
function describeState(state: TransferState): string {
  switch (state) {
  case "pending":
    return "移管の手続き中です。";
  case "completed":
    return "移管が完了しました。";
  case "rejected":
    return "移管は拒否されました。";
  case "cancelled":
    return "移管申請は取り消されました。";
  default:
    return "移管処理は完了しませんでした。";
  }
}

/**
 * Refuses a transfer-in for a domain the caller already holds here.
 *
 * Reads only `domains/${uid}__${domainName}` — a query by name would let a
 * member learn that *somebody* at this service holds a name, which is exactly
 * the cross-member leak `ownership.ts` exists to prevent. A record marked
 * `gone` (previously transferred away, or expired) does not block a new
 * transfer in.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain the member wants to bring in.
 * @return {Promise<void>} Resolves when the transfer may proceed.
 */
async function assertNotAlreadyOwned(
  uid: string,
  domainName: string,
): Promise<void> {
  let record;
  try {
    record = await loadOwnedDomain(uid, domainName);
  } catch (error) {
    // Not in the caller's mirror at all: nothing to object to. Any other
    // failure (a real Firestore problem) is left to propagate.
    if (error instanceof DomainNotOwnedError) return;
    throw error;
  }
  if (record.lifecycle !== "gone") {
    throw new TransferError(
      "alreadyOurs",
      "このドメインはすでにお客様が当サービスで管理しています。",
    );
  }
}

/**
 * Brings the local domain mirror back in line after the member answered a
 * transfer request.
 *
 * An approved transfer is definitive — the domain now belongs to another
 * registrar — so the mirror is marked `gone` without asking the registry
 * again: after the hand-over we are no longer the sponsor and `domain:info`
 * may legitimately refuse us. A rejection leaves the domain with us, so there
 * the registry is re-read and written back, which is what clears
 * `pendingTransfer` from the list screen.
 *
 * Best effort on purpose: the transfer record is already settled, and failing
 * the whole Callable because a follow-up read timed out would tell the member
 * their decision did not go through when it did.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain that was decided on.
 * @param {"approve" | "reject"} action What the member decided.
 * @param {RegistryClient} client Registry holding the domain.
 * @return {Promise<void>} Resolves once the mirror was updated, or skipped.
 */
async function syncAfterOutgoingDecision(
  uid: string,
  domainName: string,
  action: "approve" | "reject",
  client: RegistryClient,
): Promise<void> {
  try {
    if (action === "approve") {
      await syncDomainRecord(uid, domainName, null, {
        transferredAt: FieldValue.serverTimestamp(),
        autoRenew: false,
      });
      return;
    }
    const probe = await probeDomain(client, domainName);
    if (probe.kind === "info") {
      await syncDomainRecord(uid, domainName, probe.info);
    }
  } catch (error) {
    logger.error("could not sync the domain mirror after a transfer answer", {
      uid,
      domainName,
      action,
      error: String(error),
    });
  }
}
