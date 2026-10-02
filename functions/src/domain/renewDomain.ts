/**
 * The renewal use case: acquire a domain-scoped lease -> domain:renew ->
 * reconcile any ambiguous outcome via domain:info -> release the lease.
 *
 * This mirrors `provisionDomain.ts`'s attempt/state-transition/recovery shape,
 * but adds one thing create does not need: a lease. `domain:create` claims a
 * name atomically at the registry, so two concurrent creates for the same
 * name simply can't both "win". `domain:renew` has no such built-in
 * exclusivity — two racing renew Orders (different idempotency keys) for the
 * same domain could both believe they succeeded and double-extend/charge.
 * The lease, stored as the `renewLease` field on the owned
 * `domains/{uid}__{name}` document, is what makes "one non-terminal renew
 * Order per domain at a time" true.
 */
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {randomUUID} from "node:crypto";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {isRegistryError} from "../bridge/errors";
import {getRegistryClient} from "../bridge/registryRouter";
import type {DomainInfo} from "../bridge/types";
import {orderClTrid} from "./clTrid";
import {normaliseEppDateTime, validateEppDate} from "./validation";
import {
  bumpAttempts,
  transitionOrder,
  type OrderHandle,
  type OrderState,
} from "./orders";

/**
 * Lease lifetime. Deliberately longer than the Callable's 120-second budget:
 * a lease that outlives one invocation is what turns "the previous call
 * crashed mid-flight" into "wait, then let the same Order retry" instead of
 * "immediately resend and risk a double renew".
 */
export const RENEW_LEASE_MS = 5 * 60 * 1000;

/** How many renew attempts an order gets before it is written off. */
export const RENEW_MAX_ATTEMPTS = 3;

/** Outcome of one renewal run, shaped for the Callable response. */
export interface RenewResult {
  state: OrderState;
  domainName: string;
  registry: string;
  exDate?: string;
  /** True when recovery via `domain:info` proved an earlier attempt worked. */
  recovered: boolean;
  /** Message intended for the UI, already in Japanese. */
  message: string;
}

/** Stored shape of the domain-scoped renew lease. */
interface RenewLeaseDoc {
  orderId: string;
  /** Null while parked between a confirmed-safe reconciliation and a client
   * retry — that state permits the *same* order to re-enter immediately. */
  holderToken: string | null;
  periodYears: number;
  curExpDate: string;
  expectedExDate: string;
  acquiredAt: Timestamp;
  expiresAt: Timestamp;
}

/** Fields this use case reads from the owned Domain document. */
interface DomainRecord {
  uid: string;
  name: string;
  registry: RegistryId;
  exDate?: string;
  renewLease?: RenewLeaseDoc;
}

/** Result of trying to acquire the domain-scoped renew lease. */
type LeaseAcquireResult =
  | {status: "acquired"; token: string}
  | {status: "busySameOrder"}
  | {status: "blockedByOtherOrder"; ownerOrderId: string}
  | {status: "staleExpiration"; actualExDate: string | null};

/**
 * Runs one renewal attempt for an order and moves its state.
 *
 * Safe to call again on the same order: a `done` order is returned as is, a
 * `retrying` order picks up where it left off, and a concurrent invocation of
 * the same order is turned away rather than sending a second command.
 *
 * @param {OrderHandle} order Order to renew.
 * @return {Promise<RenewResult>} What the UI should show next.
 */
export async function renewDomain(order: OrderHandle): Promise<RenewResult> {
  const {domainName, registry} = order.data;

  if (order.data.state === "done") {
    return {
      state: "done",
      domainName,
      registry,
      exDate: order.data.result?.exDate,
      recovered: order.data.result?.recovered ?? false,
      message: "このドメインの更新はすでに完了しています。",
    };
  }

  // A written-off order stays written off; the member has to place a new
  // renewal, not silently retrigger a registry call on a refunded order.
  if (order.data.state === "failed") {
    return {
      state: "failed",
      domainName,
      registry,
      recovered: false,
      message: "この注文は処理できませんでした。お手数ですが再度お申し込みください。",
    };
  }

  if (
    order.data.kind !== "renew" ||
    !order.data.curExpDate ||
    !order.data.expectedExDate
  ) {
    throw new Error(`order ${order.id} is not a valid renew order`);
  }

  const lease = await acquireRenewLease(order);

  if (lease.status === "blockedByOtherOrder") {
    await transitionOrder(order, "failed", {
      error: {
        kind: "leaseBlocked",
        message: `別の注文 (${lease.ownerOrderId}) が処理中です。`,
      },
    });
    return {
      state: "failed",
      domainName,
      registry,
      recovered: false,
      message:
        "同じドメインに対する別の更新処理が進行中のため、この注文は処理できませんでした。お支払いは返金扱いになります。",
    };
  }

  if (lease.status === "staleExpiration") {
    await transitionOrder(order, "failed", {
      error: {
        kind: "staleExpiration",
        message: "ドメインの有効期限がこの注文の作成時から変更されています。",
        actualExDate: lease.actualExDate,
      },
    });
    return {
      state: "failed",
      domainName,
      registry,
      recovered: false,
      message:
        "ドメインの有効期限が変更されているため、この注文は処理できませんでした。最新の有効期限をご確認のうえ、再度お申し込みください。",
    };
  }

  if (lease.status === "busySameOrder") {
    // Another invocation of this same order is already in flight; do not
    // bump attempts or send a second command, just report where it stands.
    return {
      state: order.data.state,
      domainName,
      registry,
      exDate: order.data.result?.exDate,
      recovered: order.data.result?.recovered ?? false,
      message: "処理中です。しばらくしてから再度お試しください。",
    };
  }

  const token = lease.token;

  if (order.data.attempts > 0) {
    const reconciled = await reconcileRenewal(
      order,
      order.data.attempts,
      token,
    );
    if (reconciled !== "safe-to-send") return reconciled;
  }

  return sendRenewAttempt(order, token);
}

/**
 * Acquires the domain-scoped renew lease inside a Firestore transaction,
 * re-validating ownership, the order's expiry snapshot, and any existing
 * lease as of the committed read.
 *
 * @param {OrderHandle} order Order attempting to acquire the lease.
 * @return {Promise<LeaseAcquireResult>} What the transaction decided.
 */
async function acquireRenewLease(
  order: OrderHandle,
): Promise<LeaseAcquireResult> {
  const {uid, domainName, registry, periodYears} = order.data;
  const curExpDate = order.data.curExpDate as string;
  const expectedExDate = order.data.expectedExDate as string;
  const domainRef = db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`);

  return db().runTransaction(async (tx): Promise<LeaseAcquireResult> => {
    const snap = await tx.get(domainRef);
    const domain = snap.data() as DomainRecord | undefined;
    if (
      !domain ||
      domain.uid !== uid ||
      domain.name !== domainName ||
      domain.registry !== registry
    ) {
      throw new Error(
        "renew lease: owned domain document missing or inconsistent " +
          `for ${domainName}`,
      );
    }

    // The mirror may hold the registry's ISO-datetime form of the expiry
    // while the order snapshot is date-only; compare on the date part.
    const actualExDate = domain.exDate ?? null;
    if (
      (actualExDate === null ? null : normaliseEppDateTime(actualExDate)) !==
      curExpDate
    ) {
      return {status: "staleExpiration", actualExDate};
    }

    const existing = domain.renewLease;
    const now = Timestamp.now();
    const expired = existing !== undefined ?
      existing.expiresAt.toMillis() <= now.toMillis() :
      false;

    if (existing && existing.orderId !== order.id && !expired) {
      // A different, non-terminal order's lease is taken over here only once
      // it has expired. A terminal order's lease is always deleted in the
      // same transaction that finishes it (see commitRenewSuccess/Failure),
      // so a *present* lease does not by itself prove its owner is still
      // non-terminal — the owning invocation may simply have crashed
      // mid-flight (timeout, container kill, deploy rollover) before ever
      // reaching that terminal write. `renewOrder`'s own `timeoutSeconds`
      // (120s, renewOrder.ts) is strictly shorter than RENEW_LEASE_MS (5min,
      // above), so once `expiresAt` has passed the owning invocation can no
      // longer still be in flight issuing a `domain:renew` — reclaiming the
      // lease below cannot race a live send. Only an unexpired cross-order
      // lease still blocks.
      return {status: "blockedByOtherOrder", ownerOrderId: existing.orderId};
    }

    if (existing && existing.holderToken !== null && !expired) {
      // Reached only for the same order's own lease (a cross-order,
      // unexpired lease already returned above): its prior invocation is
      // still busy.
      return {status: "busySameOrder"};
    }

    // Fresh acquisition, this same order taking over its own expired or
    // parked lease, or a different order taking over an *expired* lease
    // (an unexpired cross-order lease already returned above). The token is
    // generated here, inside the transaction body, so that a Firestore
    // contention retry (which reruns this whole
    // callback) can never commit a token from an earlier, discarded attempt
    // — only the token returned by the callback invocation that actually
    // commits is ever handed back to the caller.
    const token = randomUUID();
    const lease: RenewLeaseDoc = {
      orderId: order.id,
      holderToken: token,
      periodYears,
      curExpDate,
      expectedExDate,
      acquiredAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + RENEW_LEASE_MS),
    };
    tx.set(domainRef, {renewLease: lease}, {merge: true});
    return {status: "acquired", token};
  });
}

/**
 * Sends a fresh `domain:renew` and moves the order according to the result.
 *
 * @param {OrderHandle} order Order being renewed.
 * @param {string} token This invocation's lease holder token.
 * @return {Promise<RenewResult>} What the UI should show next.
 */
async function sendRenewAttempt(
  order: OrderHandle,
  token: string,
): Promise<RenewResult> {
  const {domainName, registry, periodYears} = order.data;
  const curExpDate = order.data.curExpDate as string;
  const expectedExDate = order.data.expectedExDate as string;

  const attempt = await bumpAttempts(order);
  await transitionOrder(order, "provisioning");

  const client = getRegistryClient(registry);

  try {
    const outcome = await client.renewDomain(
      domainName,
      {curExpDate, period: {unit: "Y", value: periodYears}},
      orderClTrid(order.data.seq, "RENEW", attempt),
      {uid: order.data.uid, orderId: order.id},
    );

    // Real registries answer the new expiry as an ISO datetime; the order's
    // snapshot (and everything committed from here) is date-only.
    const outcomeExDate = normaliseEppDateTime(String(outcome.exDate ?? ""));
    if (outcome.domain !== domainName || !isValidExDate(outcomeExDate)) {
      // BRIDGE's own return value cannot prove what happened; treat exactly
      // like a transport/unknown failure and reconcile via domain:info.
      return handleRenewFailure(
        order,
        new Error(`domain:renew returned inconsistent data for ${domainName}`),
        attempt,
        token,
      );
    }

    // The registry's success answer is authoritative: it renewed the term
    // and charged, whatever this order's snapshot predicted. The registries
    // do not validate `curExpDate` (verified against Kitaqsign), so a stale
    // mirror snapshot makes `expectedExDate` wrong while the renewal itself
    // still succeeds — calling that "failed" is what used to send members
    // into a retry, i.e. a second, real renewal. The observed date is
    // committed as the result; the mismatch is only logged.
    if (outcomeExDate !== expectedExDate) {
      logger.warn(
        "renew exDate did not match the snapshot-derived expectation; " +
          "trusting the registry's answer",
        {
          orderId: order.id,
          domainName,
          expected: expectedExDate,
          actual: outcome.exDate,
        },
      );
    }
    await commitRenewSuccess(order, token, outcomeExDate, false);
    return {
      state: "done",
      domainName,
      registry,
      exDate: outcomeExDate,
      recovered: false,
      message: "ドメインの更新が完了しました。",
    };
  } catch (error) {
    return handleRenewFailure(order, error, attempt, token);
  }
}

/**
 * Turns a failed `domain:renew` attempt into `retrying`/`done`/`failed`.
 *
 * Only ambiguous failures (transport, unknown, or a structurally unusable
 * success envelope) are reconciled via `domain:info`; a registry-issued
 * rejection (validation, policy, auth, not-found, already-exists) is final.
 *
 * @param {OrderHandle} order Order that failed to renew.
 * @param {unknown} error Whatever was thrown.
 * @param {number} attempt Attempt number that failed.
 * @param {string} token This invocation's lease holder token.
 * @return {Promise<RenewResult>} What the UI should show next.
 */
async function handleRenewFailure(
  order: OrderHandle,
  error: unknown,
  attempt: number,
  token: string,
): Promise<RenewResult> {
  const {domainName, registry} = order.data;
  const payload = isRegistryError(error) ?
    error.toLogPayload() :
    {kind: "unknown", message: String(error)};
  logger.error("renew failed", {orderId: order.id, ...payload});

  const kind = isRegistryError(error) ? error.kind : "unknown";
  const needsReconciliation = kind === "transport" || kind === "unknown";

  if (!needsReconciliation) {
    await commitRenewFailure(order, token, undefined, payload);
    return {
      state: "failed",
      domainName,
      registry,
      recovered: false,
      message: "更新処理でエラーが発生しました。お支払いは返金扱いになります。",
    };
  }

  const reconciled = await reconcileRenewal(order, attempt, token);
  if (reconciled !== "safe-to-send") return reconciled;

  // domain:info confirms the just-attempted send has not (yet, confirmably)
  // taken effect. Resending within the same invocation risks a tight double
  // send against a possibly struggling registry, so this parks the order
  // for a later, client-driven retry instead — unless the attempt budget is
  // already spent, in which case the order is written off.
  const exhausted = attempt >= RENEW_MAX_ATTEMPTS;
  if (exhausted) {
    await commitRenewFailure(order, token, undefined, payload);
    return {
      state: "failed",
      domainName,
      registry,
      recovered: false,
      message: "更新処理が完了しませんでした。お支払いは返金扱いになります。",
    };
  }

  await parkLeaseForRetry(order, token);
  await transitionOrder(order, "retrying", {error: payload});
  return {
    state: "retrying",
    domainName,
    registry,
    recovered: false,
    message: "処理中です。自動で再試行しています。",
  };
}

/**
 * Confirms an ambiguous or re-entered renewal via `domain:info`, comparing
 * the registry's `exDate` against the order's snapshot.
 *
 * @param {OrderHandle} order Order being reconciled.
 * @param {number} attempt Attempt number to stamp on the info clTRID.
 * @param {string} token This invocation's lease holder token.
 * @return {Promise<RenewResult | "safe-to-send">} A terminal result, or
 *   `"safe-to-send"` when the domain is confirmed still at `curExpDate` and
 *   sending (or re-parking) is up to the caller.
 */
async function reconcileRenewal(
  order: OrderHandle,
  attempt: number,
  token: string,
): Promise<RenewResult | "safe-to-send"> {
  const {domainName, registry} = order.data;
  const curExpDate = order.data.curExpDate as string;
  const expectedExDate = order.data.expectedExDate as string;

  let info: DomainInfo;
  try {
    info = await getRegistryClient(registry).infoDomain(
      domainName,
      orderClTrid(order.data.seq, "INFO", attempt),
    );
  } catch (error) {
    // Neither success nor failure is provable; stay in retrying and leave
    // the lease's holder token untouched so it expires naturally, forcing a
    // wait before the same order tries to reconcile again.
    const payload = isRegistryError(error) ?
      error.toLogPayload() :
      {kind: "unknown", message: String(error)};
    logger.error("renew reconciliation info failed", {
      orderId: order.id,
      ...payload,
    });
    await transitionOrder(order, "retrying", {error: payload});
    return {
      state: "retrying",
      domainName,
      registry,
      recovered: false,
      message: "状態を確認できませんでした。しばらくしてから再度お試しください。",
    };
  }

  // Compare on the date part: the registry answers an ISO datetime while
  // both order snapshots are date-only.
  const infoExDate =
    info.exDate == null ? info.exDate : normaliseEppDateTime(info.exDate);

  if (infoExDate === expectedExDate) {
    await commitRenewSuccess(order, token, infoExDate, true);
    return {
      state: "done",
      domainName,
      registry,
      exDate: infoExDate,
      recovered: true,
      message: "ドメインの更新が完了しました。",
    };
  }

  if (infoExDate === curExpDate) {
    return "safe-to-send";
  }

  // Matches neither snapshot but the term is longer than the order's
  // starting point: the ambiguous send is the overwhelmingly likely cause
  // (the registries renew from their own stored expiry, ignoring
  // `curExpDate`, so a shifted base lands past `expectedExDate`). Treat it
  // as applied — refusing here is what turned an already-charged renewal
  // into a "failed" screen and invited a second, real renewal.
  if (
    infoExDate != null &&
    isValidExDate(infoExDate) &&
    infoExDate > curExpDate
  ) {
    logger.warn(
      "renew reconciliation found an extended exDate; treating as applied",
      {
        orderId: order.id,
        domainName,
        curExpDate,
        expectedExDate,
        actual: info.exDate ?? null,
      },
    );
    await commitRenewSuccess(order, token, infoExDate, true);
    return {
      state: "done",
      domainName,
      registry,
      exDate: infoExDate,
      recovered: true,
      message: "ドメインの更新が完了しました。",
    };
  }

  logger.error("renew reconciliation exDate matched neither snapshot", {
    orderId: order.id,
    domainName,
    curExpDate,
    expectedExDate,
    actual: info.exDate ?? null,
  });
  await commitRenewFailure(order, token, infoExDate);
  return {
    state: "failed",
    domainName,
    registry,
    recovered: false,
    message:
      "更新結果を確認できませんでした。お手数ですが最新の有効期限をご確認のうえ、必要であれば再度お申し込みください。",
  };
}

/**
 * Atomically finishes a renewal: the order becomes `done`, the domain's
 * local `exDate`/`lastRenewOrderId` are updated, and the lease is released.
 *
 * @param {OrderHandle} order Order that succeeded.
 * @param {string} token This invocation's lease holder token.
 * @param {string} exDate New expiry confirmed by the registry.
 * @param {boolean} recovered True when found via `domain:info` recovery.
 * @return {Promise<void>} Resolves once committed.
 */
async function commitRenewSuccess(
  order: OrderHandle,
  token: string,
  exDate: string,
  recovered: boolean,
): Promise<void> {
  const {uid, domainName} = order.data;
  const domainRef = db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(domainRef);
    assertLeaseOwned(snap.data() as DomainRecord | undefined, order.id, token);

    tx.set(
      order.ref,
      {
        state: "done",
        result: {exDate, recovered},
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    tx.set(
      domainRef,
      {
        exDate,
        lastRenewOrderId: order.id,
        renewLease: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  });

  order.data = {
    ...order.data,
    state: "done",
    result: {exDate, recovered},
  };
}

/**
 * Atomically fails a renewal: the order becomes `failed`, an observed
 * `exDate` is synced to the domain when there is one, and the lease is
 * released — without touching the order's own `curExpDate`/`expectedExDate`
 * snapshot.
 *
 * @param {OrderHandle} order Order that failed.
 * @param {string} token This invocation's lease holder token.
 * @param {string | undefined} observedExDate Registry-confirmed expiry to
 *   sync locally, when one was actually observed.
 * @param {Record<string, unknown> | undefined} errorPayload Error detail to
 *   store on the order.
 * @return {Promise<void>} Resolves once committed.
 */
async function commitRenewFailure(
  order: OrderHandle,
  token: string,
  observedExDate: string | undefined,
  errorPayload?: Record<string, unknown>,
): Promise<void> {
  const {uid, domainName} = order.data;
  const domainRef = db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(domainRef);
    assertLeaseOwned(snap.data() as DomainRecord | undefined, order.id, token);

    tx.set(
      order.ref,
      {
        state: "failed",
        ...(errorPayload ? {error: errorPayload} : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    tx.set(
      domainRef,
      {
        ...(observedExDate ? {exDate: observedExDate} : {}),
        renewLease: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  });

  order.data = {
    ...order.data,
    state: "failed",
    ...(errorPayload ? {error: errorPayload} : {}),
  };
}

/**
 * Parks the lease between a confirmed-safe reconciliation and a later,
 * client-driven retry by clearing its holder token, letting the same order
 * re-enter immediately without waiting out the full TTL.
 *
 * @param {OrderHandle} order Order whose lease should be parked.
 * @param {string} token This invocation's lease holder token.
 * @return {Promise<void>} Resolves once committed (a no-op if the lease has
 *   already moved on from this invocation).
 */
async function parkLeaseForRetry(
  order: OrderHandle,
  token: string,
): Promise<void> {
  const {uid, domainName} = order.data;
  const domainRef = db()
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${domainName}`);

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(domainRef);
    const lease = (snap.data() as DomainRecord | undefined)?.renewLease;
    if (!lease || lease.orderId !== order.id || lease.holderToken !== token) {
      // Superseded or already released since this invocation started;
      // nothing of this invocation's to park.
      return;
    }
    tx.set(
      domainRef,
      {
        renewLease: {...lease, holderToken: null},
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  });
}

/**
 * Verifies that a domain's current lease still belongs to this invocation
 * before a terminal commit is allowed to touch it.
 *
 * Fencing on both `orderId` and `holderToken` (not just `orderId`) is what
 * stops a stale invocation — one whose lease already expired and was taken
 * over by a newer invocation of the same order — from releasing or
 * overwriting that newer invocation's state.
 *
 * @param {DomainRecord | undefined} domain Domain document as read inside
 *   the terminal transaction.
 * @param {string} orderId Id of the order committing.
 * @param {string} token This invocation's lease holder token.
 * @return {void} Nothing; throws on mismatch.
 */
function assertLeaseOwned(
  domain: DomainRecord | undefined,
  orderId: string,
  token: string,
): void {
  const lease = domain?.renewLease;
  if (!lease || lease.orderId !== orderId || lease.holderToken !== token) {
    throw new Error(
      `renew lease token mismatch on terminal commit for order ${orderId}`,
    );
  }
}

/**
 * Whether a registry-returned expiry string is a well-formed EPP date.
 *
 * @param {string | undefined} exDate Value to check.
 * @return {boolean} True when it is a valid `YYYY-MM-DD` date.
 */
function isValidExDate(exDate: string | undefined): exDate is string {
  if (!exDate) return false;
  try {
    validateEppDate(exDate, "exDate");
    return true;
  } catch {
    return false;
  }
}
