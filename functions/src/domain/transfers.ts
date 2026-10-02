/**
 * The `transfers` collection: one record per domain a member is moving in or
 * out, plus the claim that keeps two invocations from issuing the same
 * registry command twice (spec 6.6).
 *
 *   (no record) ──request(in)──▶ pending ──approve/auto──▶ completed
 *                                   │
 *                                   ├──reject──▶ rejected
 *                                   ├──cancel──▶ cancelled
 *                                   └──our command failed──▶ failed
 *
 * The document id is `${uid}__${domainName}`, which is what makes a
 * double-submitted transfer form safe: the second submit lands on the same
 * document, sees it is already `pending`, and never reaches the registry. It
 * is the same trick `orders.ts` plays with the idempotency key, but keyed on
 * the domain instead — a member can only have one transfer of one domain in
 * flight at the registry anyway, so the domain *is* the natural key.
 *
 * Unlike `orders.ts` this is not a payment record. A transfer has no price in
 * this service (§6.2.5 / TBD #7 leave the transfer fee open), and its
 * terminal state is decided by the *other* registrar rather than by us, which
 * is why it has its own small state machine instead of reusing the order one:
 * `retrying` would be a lie here, since nothing of ours retries.
 *
 * ## The claim
 *
 * `holderToken` is the same fencing idea as `renewDomain.ts`'s lease. Every
 * transfer command is non-idempotent at the registry, so exactly one
 * invocation at a time may be in flight for one record. The token is minted
 * inside the claiming transaction and re-checked inside the settling one, so
 * an invocation whose claim expired and was taken over cannot write its stale
 * conclusion over the newer one.
 */
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
} from "firebase-admin/firestore";
import {randomUUID} from "node:crypto";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";

/** Which way a domain is moving, from this service's point of view. */
export type TransferDirection =
  /** We are the gaining registrar: the member is bringing a domain in. */
  | "in"
  /** We are the losing registrar: somebody is asking for our domain. */
  | "out";

/** Where a transfer stands. */
export type TransferState =
  /** Requested and waiting on the losing registrar (or the 20-minute clock). */
  | "pending"
  /** The domain changed hands. */
  | "completed"
  /** The losing registrar refused. */
  | "rejected"
  /** The gaining registrar withdrew the request. */
  | "cancelled"
  /** Our own command could not be carried out; nothing changed hands. */
  | "failed";

/** States from which no further work happens. */
const TERMINAL_STATES: readonly TransferState[] = [
  "completed",
  "rejected",
  "cancelled",
  "failed",
];

/**
 * How long the losing registrar has before the registry approves on its
 * behalf. The pseudo-registries shorten the real five days to 20 minutes
 * (spec 6.6.1), and the screen has to say so, so the deadline is computed and
 * stored rather than left for the UI to guess.
 */
export const TRANSFER_AUTO_APPROVE_MS = 20 * 60 * 1000;

/**
 * How long one invocation may hold a transfer record.
 *
 * Deliberately longer than the Callable's timeout budget, for the same reason
 * the renew lease is: a claim that outlives one invocation turns "the last
 * call died mid-flight" into "wait, then try again" instead of "send a second
 * transfer command immediately".
 */
export const TRANSFER_CLAIM_MS = 5 * 60 * 1000;

/** Stored shape of a transfer. */
export interface TransferDoc {
  uid: string;
  domainName: string;
  registry: RegistryId;
  direction: TransferDirection;
  state: TransferState;
  /** Registrar id gaining the domain, as the registry reported it. */
  gainingRegistrar: string | null;
  /** Registrar id losing the domain, as the registry reported it. */
  losingRegistrar: string | null;
  /** When the transfer was requested (ISO 8601). */
  requestedAt: string | null;
  /** `requestedAt` + 20 minutes (ISO 8601), for the UI's countdown. */
  autoApproveAt: string | null;
  /** Set while one invocation is talking to the registry. */
  holderToken: string | null;
  /** When the current holder's claim lapses. */
  holderExpiresAt: Timestamp | null;
  /** Poll message that last moved this record, for traceability. */
  lastPollMessageId: string | null;
  error?: Record<string, unknown>;
}

/** A stored transfer together with the handle needed to update it. */
export interface TransferRecord {
  id: string;
  ref: DocumentReference;
  data: TransferDoc;
}

/** What a claim attempt decided. */
export type TransferClaim =
  /** The caller may now issue its registry command. */
  | {status: "claimed"; token: string; record: TransferRecord}
  /** Another invocation is mid-flight on this record. */
  | {status: "busy"; record: TransferRecord}
  /** No record exists and the caller does not open one. */
  | {status: "missing"}
  /** A record exists but not in a state this caller can act on. */
  | {status: "wrongState"; record: TransferRecord};

/** Everything needed to claim (and possibly open) a transfer record. */
export interface ClaimTransferInput {
  uid: string;
  domainName: string;
  /**
   * Registry to record when this claim *opens* the record. An existing
   * record's own registry always wins: it was resolved when the transfer
   * started and is the only one the outstanding registry-side request lives
   * on, so re-deriving it here could send a later command to the wrong host.
   */
  registry: RegistryId;
  /** Direction to record. Only meaningful when the record is being opened
   * or restarted; use `expectDirection` to *guard* on the stored one. */
  direction: TransferDirection;
  /** States an existing record may be in for the claim to succeed. */
  allowedStates: readonly TransferState[];
  /** True when the caller opens a record that does not exist yet. */
  openIfMissing: boolean;
  /**
   * When set, an existing record whose stored direction differs is refused.
   * This is what stops the losing-side `approve` from being pointed at an
   * inbound request (and vice versa) — the direction decides which registrar
   * the registry will even accept the command from (spec 6.6.1).
   */
  expectDirection?: TransferDirection;
}

/**
 * Document id for one member's transfer of one domain.
 *
 * Scoped by uid so an ownership check is a point read rather than a query:
 * there is no window in which a stale index could hand one member another
 * member's transfer.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain being transferred.
 * @return {string} Firestore document id.
 */
export function transferDocId(uid: string, domainName: string): string {
  return `${uid}__${domainName}`;
}

/**
 * Whether a transfer has reached a state where nothing more happens.
 *
 * @param {TransferState} state State to inspect.
 * @return {boolean} True when the transfer is settled.
 */
export function isTerminalTransfer(state: TransferState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Offset the registries use when they omit the zone from a timestamp. */
const REGISTRY_LOCAL_OFFSET = "+09:00";

/**
 * Pins a registry timestamp to a zone.
 *
 * Kitaqsign answers `reDate` as `2026-08-28T17:18:55.374423` — JST, no zone
 * designator. `Date.parse` reads such a string as local time, which on a
 * UTC Cloud Functions host lands nine hours in the future, so the deadline
 * derived from it (and every comparison against `Date.now()`) drifts by the
 * same nine hours. Anything already carrying `Z` or an offset is untouched.
 *
 * @param {string} value Timestamp as the registry spelled it.
 * @return {string} The same instant with an explicit zone.
 */
export function normaliseRegistryTimestamp(value: string): string {
  const trimmed = value.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)) {
    return trimmed + REGISTRY_LOCAL_OFFSET;
  }
  return trimmed;
}

/**
 * Computes the deadline after which the registry approves a pending transfer
 * without the losing registrar doing anything (spec 6.6.1).
 *
 * @param {string | null} requestedAt Request timestamp, ISO 8601.
 * @return {string | null} Deadline as ISO 8601, or null when the request
 *   timestamp is missing or unparseable.
 */
export function autoApproveDeadline(
  requestedAt: string | null,
): string | null {
  if (!requestedAt) return null;
  const requested = Date.parse(normaliseRegistryTimestamp(requestedAt));
  if (Number.isNaN(requested)) return null;
  return new Date(requested + TRANSFER_AUTO_APPROVE_MS).toISOString();
}

/**
 * Reads one member's transfer record.
 *
 * The point read is the tenant boundary: the id embeds the caller's uid, and
 * the stored `uid`/`domainName` are re-checked, so a document belonging to
 * somebody else can never be returned.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {string} domainName Domain being transferred.
 * @return {Promise<TransferRecord | null>} The record, or null.
 */
export async function loadTransfer(
  uid: string,
  domainName: string,
): Promise<TransferRecord | null> {
  const id = transferDocId(uid, domainName);
  const ref = db().collection(COLLECTIONS.transfers).doc(id);
  const snapshot = await ref.get();
  const data = snapshot.data() as TransferDoc | undefined;
  if (!data || data.uid !== uid || data.domainName !== domainName) return null;
  return {id, ref, data};
}

/**
 * Lists a member's transfers, optionally filtered by state and direction.
 *
 * The `uid == uid` filter is the tenant boundary for the list flow. Both
 * filters are equalities, which Firestore serves from its automatic
 * single-field indexes — no composite index is needed, and none is declared.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {object} filter Optional direction / state narrowing.
 * @return {Promise<TransferRecord[]>} Matching transfers, newest request
 *   first, with an unknown request time sorted last.
 */
export async function listTransfers(
  uid: string,
  filter: {direction?: TransferDirection; state?: TransferState} = {},
): Promise<TransferRecord[]> {
  let query = db()
    .collection(COLLECTIONS.transfers)
    .where("uid", "==", uid);
  if (filter.direction) {
    query = query.where("direction", "==", filter.direction);
  }
  if (filter.state) query = query.where("state", "==", filter.state);

  const snapshot = await query.get();
  const records = snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data() as TransferDoc,
    }))
    .filter((record) => record.data.uid === uid);

  records.sort((a, b) =>
    (b.data.requestedAt ?? "").localeCompare(a.data.requestedAt ?? ""),
  );
  return records;
}

/**
 * Claims a transfer record for this invocation, opening it when the caller is
 * the one that starts a transfer.
 *
 * The read, the state check and the write all happen inside one Firestore
 * transaction, so two concurrent invocations cannot both conclude the record
 * is theirs. The token is minted inside the transaction body for the same
 * reason it is in `renewDomain.ts`: a contention retry reruns the body, and
 * only the run that actually commits may hand its token back.
 *
 * @param {ClaimTransferInput} input What the caller intends to do.
 * @return {Promise<TransferClaim>} What the transaction decided.
 */
export async function claimTransfer(
  input: ClaimTransferInput,
): Promise<TransferClaim> {
  const id = transferDocId(input.uid, input.domainName);
  const ref = db().collection(COLLECTIONS.transfers).doc(id);

  return db().runTransaction(async (tx): Promise<TransferClaim> => {
    const snapshot = await tx.get(ref);
    const existing = snapshot.data() as TransferDoc | undefined;
    const now = Timestamp.now();

    if (existing) {
      const record: TransferRecord = {id, ref, data: existing};
      const held =
        existing.holderToken !== null &&
        (existing.holderExpiresAt?.toMillis() ?? 0) > now.toMillis();
      if (held) return {status: "busy", record};
      if (!input.allowedStates.includes(existing.state)) {
        return {status: "wrongState", record};
      }
      if (
        input.expectDirection !== undefined &&
        existing.direction !== input.expectDirection
      ) {
        return {status: "wrongState", record};
      }
    } else if (!input.openIfMissing) {
      return {status: "missing"};
    }

    const token = randomUUID();
    const data: TransferDoc = {
      uid: input.uid,
      domainName: input.domainName,
      // Never re-derived over an existing record: see ClaimTransferInput.
      registry: existing?.registry ?? input.registry,
      direction: input.direction,
      // A brand-new record starts `failed`, not `pending`. Nothing has been
      // asked of the registry at the instant it is created, and if this
      // invocation dies before it settles, `failed` is both the truthful
      // description ("no transfer exists") and the one that lets the member
      // simply try again — a stranded `pending` would show a transfer that
      // was never requested and block every retry.
      state: existing?.state ?? "failed",
      gainingRegistrar: existing?.gainingRegistrar ?? null,
      losingRegistrar: existing?.losingRegistrar ?? null,
      requestedAt: existing?.requestedAt ?? null,
      autoApproveAt: existing?.autoApproveAt ?? null,
      holderToken: token,
      holderExpiresAt: Timestamp.fromMillis(
        now.toMillis() + TRANSFER_CLAIM_MS,
      ),
      lastPollMessageId: existing?.lastPollMessageId ?? null,
    };

    tx.set(
      ref,
      {
        ...data,
        ...(existing ? {} : {createdAt: FieldValue.serverTimestamp()}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return {status: "claimed", token, record: {id, ref, data}};
  });
}

/** Fields a settling caller may write alongside the new state. */
export interface TransferSettlement {
  state: TransferState;
  gainingRegistrar?: string | null;
  losingRegistrar?: string | null;
  requestedAt?: string | null;
  autoApproveAt?: string | null;
  error?: Record<string, unknown> | null;
}

/**
 * Writes the outcome of a claimed invocation and releases the claim.
 *
 * Fencing on the token — not merely on the document id — is what stops an
 * invocation whose claim already expired (and was taken over by a newer one)
 * from overwriting the newer invocation's conclusion.
 *
 * @param {TransferRecord} record Record that was claimed.
 * @param {string} token This invocation's claim token.
 * @param {TransferSettlement} settlement New state and accompanying fields.
 * @return {Promise<void>} Resolves once committed.
 */
export async function settleTransfer(
  record: TransferRecord,
  token: string,
  settlement: TransferSettlement,
): Promise<void> {
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(record.ref);
    const current = snapshot.data() as TransferDoc | undefined;
    if (!current || current.holderToken !== token) {
      throw new Error(
        `transfer claim token mismatch on settle for ${record.id}`,
      );
    }

    const patch: Record<string, unknown> = {
      state: settlement.state,
      holderToken: null,
      holderExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (settlement.gainingRegistrar !== undefined) {
      patch.gainingRegistrar = settlement.gainingRegistrar;
    }
    if (settlement.losingRegistrar !== undefined) {
      patch.losingRegistrar = settlement.losingRegistrar;
    }
    if (settlement.requestedAt !== undefined) {
      patch.requestedAt = settlement.requestedAt;
    }
    if (settlement.autoApproveAt !== undefined) {
      patch.autoApproveAt = settlement.autoApproveAt;
    }
    if (settlement.error !== undefined) {
      patch.error = settlement.error ?? FieldValue.delete();
    }

    tx.set(record.ref, patch, {merge: true});
  });

  record.data = {
    ...record.data,
    ...settlement,
    // `null` in a settlement means "delete the field", which in memory is
    // `undefined`; an omitted `error` leaves whatever was already there. The
    // caller's copy has to match what was actually stored either way.
    error: "error" in settlement ?
      settlement.error ?? undefined :
      record.data.error,
    holderToken: null,
    holderExpiresAt: null,
  };
}

/**
 * Releases a claim without changing the state, so the same member can try
 * again straight away instead of waiting out the full claim window.
 *
 * A no-op when the claim has already moved on, which is the point: a stale
 * invocation must not clear a newer one's claim.
 *
 * @param {TransferRecord} record Record that was claimed.
 * @param {string} token This invocation's claim token.
 * @return {Promise<void>} Resolves once committed.
 */
export async function releaseTransferClaim(
  record: TransferRecord,
  token: string,
): Promise<void> {
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(record.ref);
    const current = snapshot.data() as TransferDoc | undefined;
    if (!current || current.holderToken !== token) return;
    tx.set(
      record.ref,
      {
        holderToken: null,
        holderExpiresAt: null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  });
  record.data = {...record.data, holderToken: null, holderExpiresAt: null};
}

/** What the poll worker learned about one domain's transfer. */
export interface TransferNotification {
  uid: string;
  domainName: string;
  registry: RegistryId;
  direction: TransferDirection;
  state: TransferState;
  gainingRegistrar?: string | null;
  losingRegistrar?: string | null;
  requestedAt?: string | null;
  pollMessageId: string;
}

/**
 * Every pending transfer, across all members.
 *
 * The reconciler's work list: an equality-only query served by Firestore's
 * automatic single-field index. Bounded so one run cannot grow without limit.
 *
 * @param {number} limit Upper bound on records returned.
 * @return {Promise<TransferRecord[]>} Pending transfers, oldest first.
 */
export async function listPendingTransfersAcrossMembers(
  limit: number,
): Promise<TransferRecord[]> {
  const snapshot = await db()
    .collection(COLLECTIONS.transfers)
    .where("state", "==", "pending")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() as TransferDoc,
  }));
}

/** What `recordTransferNotification` did with a notification. */
export type NotificationOutcome = "written" | "skippedHeld" | "skippedTerminal";

/**
 * Records what a poll notification says about a transfer.
 *
 * Two things it deliberately does not do. It never touches a record another
 * invocation currently holds — a notification arriving while a member's own
 * approve is mid-flight must not race that command's own conclusion — and it
 * never moves a settled record back to `pending`, because the registry hands
 * out the oldest unacked message first and a redelivered old request would
 * otherwise reopen a transfer that has already finished.
 *
 * @param {TransferNotification} notification What the message reported.
 * @return {Promise<NotificationOutcome>} Whether the record was written.
 */
export async function recordTransferNotification(
  notification: TransferNotification,
): Promise<NotificationOutcome> {
  const id = transferDocId(notification.uid, notification.domainName);
  const ref = db().collection(COLLECTIONS.transfers).doc(id);

  return db().runTransaction(async (tx): Promise<NotificationOutcome> => {
    const existing = (await tx.get(ref)).data() as TransferDoc | undefined;
    const now = Timestamp.now();

    if (
      existing?.holderToken &&
      (existing.holderExpiresAt?.toMillis() ?? 0) > now.toMillis()
    ) {
      return "skippedHeld";
    }
    // A settled record must not be reopened by a *redelivery* — the registry
    // hands out the oldest unacked message first, so a request that was
    // already answered can come round again after a failed ack. A redelivery
    // is the same message, so it carries the same id. A pending notification
    // with a *different* id over a terminal record is not a redelivery: it is
    // a brand-new transfer of the same name (a domain we once gained being
    // requested away again), and refusing it would leave the member with no
    // approval screen and a mirror that still says the domain is theirs.
    if (
      notification.state === "pending" &&
      existing &&
      isTerminalTransfer(existing.state) &&
      existing.lastPollMessageId === notification.pollMessageId
    ) {
      return "skippedTerminal";
    }

    const requestedAt =
      notification.requestedAt ??
      existing?.requestedAt ??
      new Date().toISOString();

    tx.set(
      ref,
      {
        uid: notification.uid,
        domainName: notification.domainName,
        registry: notification.registry,
        direction: notification.direction,
        state: notification.state,
        gainingRegistrar:
          notification.gainingRegistrar ?? existing?.gainingRegistrar ?? null,
        losingRegistrar:
          notification.losingRegistrar ?? existing?.losingRegistrar ?? null,
        requestedAt,
        autoApproveAt: autoApproveDeadline(requestedAt),
        holderToken: null,
        holderExpiresAt: null,
        lastPollMessageId: notification.pollMessageId,
        ...(existing ? {} : {createdAt: FieldValue.serverTimestamp()}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return "written";
  });
}
