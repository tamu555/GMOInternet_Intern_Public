/**
 * The asynchronous half of transfer (spec 6.6 / 3.7, FIG.3).
 *
 * A transfer is the one operation this service cannot finish on its own: the
 * gaining side asks, the losing side answers, and whoever was not involved in
 * that answer learns about it from the poll queue. The registry also approves
 * on the losing registrar's behalf 20 minutes after the request (spec 6.6.1),
 * which means a transfer can complete with nobody having clicked anything —
 * the notification is the *only* way that becomes visible.
 *
 * ## The documented shape
 *
 * Both OpenAPI documents now specify the message (`PollMessageDto`, and the
 * 「メッセージの読み方」 table in `info.description`):
 *
 * ```json
 * { "id": 42, "msgType": "domain:transfer",
 *   "payload": { "op": "request", "domain": "example.com",
 *                "counterpartyRegistrar": "teamb" },
 *   "qdate": "2026-08-26T09:00:00" }
 * ```
 *
 * `payload.op` is the discriminator, and it also fixes which side of the
 * transfer we are on, because the registry only ever delivers a message to
 * the registrar it concerns:
 *
 * | `op`      | delivered to | so we are the … |
 * |-----------|--------------|-----------------|
 * | `request` | losing       | losing registrar (someone wants our domain) |
 * | `cancel`  | losing       | losing registrar (they withdrew it)         |
 * | `approve` | gaining      | gaining registrar (we got the domain)       |
 * | `reject`  | gaining      | gaining registrar (we did not)              |
 *
 * `counterpartyRegistrar` is the *other* side, relative to that direction —
 * never an absolute "gaining"/"losing" field. The 20-minute auto-approve also
 * sends `approve`, and also only to the gaining side: the losing registrar
 * gets no notification at all when it lets the clock run out (see
 * `docs/FIXME/TODO.md` — a pending-transfer reconciler is the follow-up).
 *
 * ## Why the guesswork is still here
 *
 * The legacy spellings (`transfer.request`, `TRANSFER_APPROVE`, …) and the
 * key-guessing fallback are kept as a second path, used only when a payload
 * carries no `op`. They cost nothing, and they are what keeps a registry that
 * spells one message differently from going unhandled.
 *
 * Anything this module still cannot understand is logged with the message id
 * and left marked in `pollMessages`, so it can be replayed once the real shape
 * is known. It is never thrown away — and, because the poll worker acks before
 * it hands the message here, a message this module cannot parse still never
 * blocks the queue.
 */
import * as logger from "firebase-functions/logger";
import {FieldValue} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import {resolveRegistryCredentials, type RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import {isRegistryError} from "../bridge/errors";
import type {PollMessage} from "../bridge/types";
import {domainClTrid} from "./clTrid";
import {syncDomainRecord} from "./domainRecords";
import {
  normalisePollMsgType,
  registerPollHandler,
} from "./pollWorker";
import {
  recordTransferNotification,
  type TransferDirection,
  type TransferDoc,
  type TransferState,
} from "./transfers";

/**
 * Message types this module claims.
 *
 * `domain:transfer` is the documented one (both registries: `PollMessageDto`
 * 「移管に関する通知は domain:transfer」). Matching is punctuation- and
 * case-insensitive, so one entry per *concept* is enough; the rest are kept
 * because they cost nothing and a per-operation spelling would otherwise land
 * as "unhandled".
 */
export const TRANSFER_POLL_MSG_TYPES = [
  "domain:transfer",
  "transfer.request",
  "transfer.approve",
  "transfer.reject",
  "transfer.cancel",
  "domain.transfer.request",
  "domain.transfer.approve",
  "domain.transfer.reject",
  "domain.transfer.cancel",
] as const;

/**
 * Payload key that carries the documented event discriminator.
 * `op` ∈ {request, approve, reject, cancel}.
 */
const OP_KEY = "op";

/** Documented payload key holding the other registrar's id. */
const COUNTERPARTY_KEY = "counterpartyRegistrar";

/**
 * Payload keys that hold the domain. `domain` is the documented one; the rest
 * are only reached by a payload that does not follow the documented shape.
 */
const DOMAIN_KEYS = ["domain", "domainName", "name", "objId", "object"];

/** Payload keys that may nest the real body one level down. */
const NESTED_KEYS = ["resData", "data", "domain", "transfer", "payload"];

/**
 * Payload keys that may hold absolute registrar ids.
 *
 * Not part of the documented shape — that one names only the *counterparty*,
 * relative to the direction `op` implies (see the module comment). These are
 * a fallback for a payload with no `op`, never a source of truth.
 */
const GAINING_KEYS = ["gainingRegistrar", "gaining", "acId", "reId"];
const LOSING_KEYS = ["losingRegistrar", "losing", "clId"];

/** Payload keys that may hold the request timestamp. */
/** What one notification says happened. */
type TransferEvent = "requested" | "approved" | "rejected" | "cancelled";

/** Documented `op` values, and the event each one reports. */
const EVENT_FOR_OP: Record<string, TransferEvent> = {
  request: "requested",
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
};

/**
 * Which side of the transfer *we* are on for each documented `op`, from the
 * registry's own routing table: a message is only ever delivered to the
 * registrar it concerns.
 */
const DIRECTION_FOR_OP: Record<string, TransferDirection> = {
  request: "out",
  cancel: "out",
  approve: "in",
  reject: "in",
};

/** A notification this module was able to understand. */
interface ParsedNotification {
  event: TransferEvent;
  domainName: string;
  /**
   * Side we are on according to the documented routing table, or null when
   * the payload carried no `op` and the direction has to be inferred from
   * what we hold.
   */
  documentedDirection: TransferDirection | null;
  /** `counterpartyRegistrar`: the other side, relative to the direction. */
  counterpartyRegistrar: string | null;
  /** Absolute ids, from the fallback keys only. Usually null. */
  gainingRegistrar: string | null;
  losingRegistrar: string | null;
  requestedAt: string | null;
}

/**
 * Reads a string field out of an untyped payload, trying several keys.
 *
 * @param {Record<string, unknown>} payload Message payload.
 * @param {string[]} keys Candidate field names, in priority order.
 * @return {string | null} First non-empty string found.
 */
function pickString(
  payload: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Flattens a payload one level, so a body nested under `resData` (or a
 * similar wrapper) is searched as well as the top level.
 *
 * @param {Record<string, unknown>} payload Message payload.
 * @return {Record<string, unknown>} Merged view; the top level wins.
 */
function flatten(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const key of NESTED_KEYS) {
    const nested = payload[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(merged, nested as Record<string, unknown>);
    }
  }
  return {...merged, ...payload};
}

/**
 * Reads an event out of one free-text source (a `msgType`, or a payload
 * `status`), already folded to letters.
 *
 * `request` is tested first on purpose: a source that merely *mentions*
 * approval — "pendingApproval", "awaitingApprove" — must never be read as an
 * approval that has happened, because that is the one misreading that hands a
 * domain away on screen. Everything else is mutually exclusive in practice.
 *
 * @param {string} source Normalised words to inspect.
 * @return {TransferEvent | null} The event, or null when it says nothing.
 */
function eventFromWords(source: string): TransferEvent | null {
  if (!source) return null;
  if (source.includes("request")) return "requested";
  if (source.includes("cancel")) return "cancelled";
  if (source.includes("reject") || source.includes("denied")) {
    return "rejected";
  }
  if (source.includes("approve") || source.includes("complete")) {
    return "approved";
  }
  if (source.includes("pending")) return "requested";
  return null;
}

/**
 * Works out which of the four transfer events a message reports.
 *
 * `payload.op` is the documented discriminator and is authoritative whenever
 * it is present: an unrecognised `op` is refused outright rather than being
 * pattern-matched into one of the four, since a registry that grew a fifth
 * operation must not have it silently filed as one of ours.
 *
 * Without an `op` the message does not follow the documented shape, and the
 * older heuristic takes over: the `msgType` first — a type names exactly one
 * operation, so it can never be ambiguous — then a payload `status`.
 *
 * @param {string} msgType Message type as the registry spells it.
 * @param {Record<string, unknown>} payload Flattened payload.
 * @return {TransferEvent | null} The event, or null when this is not a
 *   transfer message we understand.
 */
function classifyEvent(
  msgType: string,
  payload: Record<string, unknown>,
): TransferEvent | null {
  const op = pickString(payload, [OP_KEY]);
  if (op) return EVENT_FOR_OP[op.toLowerCase()] ?? null;

  const key = normalisePollMsgType(msgType);
  const status = normalisePollMsgType(pickString(payload, ["status"]) ?? "");
  if (!key.includes("transfer") && !status) return null;

  return eventFromWords(key) ?? eventFromWords(status);
}

/**
 * Turns a raw poll message into the facts this module needs.
 *
 * @param {PollMessage} message Message as the worker received it.
 * @return {ParsedNotification | null} Parsed facts, or null when the message
 *   could not be understood.
 */
export function parseTransferNotification(
  message: PollMessage,
): ParsedNotification | null {
  const payload = flatten(message.payload ?? {});
  const event = classifyEvent(message.msgType, payload);
  if (!event) return null;

  const domainName = pickString(payload, DOMAIN_KEYS)?.toLowerCase() ?? null;
  if (!domainName) return null;

  const op = pickString(payload, [OP_KEY])?.toLowerCase();

  return {
    event,
    domainName,
    documentedDirection: op ? DIRECTION_FOR_OP[op] ?? null : null,
    counterpartyRegistrar: pickString(payload, [COUNTERPARTY_KEY]),
    gainingRegistrar: pickString(payload, GAINING_KEYS),
    losingRegistrar: pickString(payload, LOSING_KEYS),
    // Receipt time, not the payload's `reDate`: kitaqsign omits the zone and
    // kitaqnic labels JST as `Z`, so the registry's own stamp can be nine
    // hours out. A `request` is at most one poll interval old when it lands.
    requestedAt: new Date().toISOString(),
  };
}

/** The two sides of a transfer, as they should be stored. */
interface TransferRegistrars {
  gainingRegistrar: string | null;
  losingRegistrar: string | null;
}

/**
 * Fills in the two registrar ids from what the notification actually said.
 *
 * The documented payload names only the counterparty, so the side it belongs
 * on is decided by the direction *we* ended up on — not by the raw `op` —
 * and our own id fills the other side. That keeps the record right even in
 * the undocumented case where an `approve` reaches the losing registrar.
 *
 * Our own id comes from the registrar credentials; when it is unavailable
 * (an unset secret reads as an empty string) only the counterparty is
 * written, and the other side is left for a later notification to fill in
 * rather than guessed.
 *
 * @param {TransferDirection} direction Side of the transfer we are on.
 * @param {ParsedNotification} parsed What the message said.
 * @param {RegistryId} registry Registry the message came from.
 * @return {TransferRegistrars} Ids to store, either of which may be null.
 */
function registrarsFor(
  direction: TransferDirection,
  parsed: ParsedNotification,
  registry: RegistryId,
): TransferRegistrars {
  if (!parsed.counterpartyRegistrar) {
    // Undocumented payload: absolute keys are all there is to go on.
    return {
      gainingRegistrar: parsed.gainingRegistrar,
      losingRegistrar: parsed.losingRegistrar,
    };
  }

  const ours = ourRegistrarId(registry);
  return direction === "out" ?
    {
      gainingRegistrar: parsed.counterpartyRegistrar,
      losingRegistrar: ours ?? parsed.losingRegistrar,
    } :
    {
      gainingRegistrar: ours ?? parsed.gainingRegistrar,
      losingRegistrar: parsed.counterpartyRegistrar,
    };
}

/**
 * This service's own `X-Registrar-Id`, as the registry sees us.
 *
 * Best effort: reading a secret outside a function that declares it yields an
 * empty string, and an empty registrar id is worse than none at all.
 *
 * @param {RegistryId} registry Registry the message came from.
 * @return {string | null} Our registrar id, or null when it is unavailable.
 */
function ourRegistrarId(registry: RegistryId): string | null {
  try {
    const id = resolveRegistryCredentials(registry).registrarId.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** State a stored transfer record should end up in for each event. */
const STATE_FOR_EVENT: Record<TransferEvent, TransferState> = {
  requested: "pending",
  approved: "completed",
  rejected: "rejected",
  cancelled: "cancelled",
};

/** Who at this service a notification concerns. */
interface TransferSubject {
  uid: string;
  registry: RegistryId;
  direction: TransferDirection;
}

/**
 * The member who holds this domain here, if any: we are the losing registrar.
 *
 * An equality-only query, which Firestore serves from its automatic
 * single-field indexes, so no composite index is declared for it.
 *
 * @param {string} domainName Domain the notification is about.
 * @return {Promise<TransferSubject | null>} The outbound subject, or null.
 */
async function findLosingSubject(
  domainName: string,
): Promise<TransferSubject | null> {
  const owned = await db()
    .collection(COLLECTIONS.domains)
    .where("name", "==", domainName)
    .get();
  const mirrors = owned.docs
    .map((doc) => doc.data())
    .filter(
      (data) =>
        typeof data.uid === "string" &&
        (data.registry === "kitaqsign" || data.registry === "kitaqnic"),
    );
  const live = mirrors.find((data) => data.lifecycle !== "gone");
  if (live) {
    return {
      uid: live.uid as string,
      registry: live.registry as RegistryId,
      direction: "out",
    };
  }

  // Only a gone mirror (or nothing) matches. A losing-side message is still
  // hard evidence: the registry delivers request/cancel to the registrar
  // that *currently sponsors* the domain, so if it reached our queue, we
  // hold the name right now and the mirror is stale — a domain that left us
  // can come back (a console-side transfer, a re-registration under the
  // same member). Verify against the registry before believing either side:
  // revive the mirror only when `domain:info` is readable and the
  // registrant is still the member's, so a name that now belongs to someone
  // else stays untouchable (the gone-domain access rule).
  const stale = mirrors.find((data) => data.lifecycle === "gone");
  if (!stale || typeof stale.registrant !== "string" || !stale.registrant) {
    return null;
  }
  const registry = stale.registry as RegistryId;
  const uid = stale.uid as string;
  try {
    const info = await getRegistryClient(registry).infoDomain(
      domainName,
      domainClTrid("INFO", domainName, Date.now().toString(36)),
    );
    if (info.registrant !== stale.registrant) return null;
    await syncDomainRecord(uid, domainName, info);
    logger.info("revived a stale gone mirror for a losing-side message", {
      uid,
      domainName,
      registry,
    });
    return {uid, registry, direction: "out"};
  } catch (error) {
    if (isRegistryError(error)) {
      // Unreachable or genuinely not visible to us: the mirror stands.
      logger.warn("could not verify a losing-side message against a gone " +
        "mirror", {domainName, registry, error: error.message});
      return null;
    }
    throw error;
  }
}

/**
 * The member who asked for this domain, if any: we are the gaining registrar.
 *
 * @param {string} domainName Domain the notification is about.
 * @return {Promise<TransferSubject | null>} The inbound subject, or null.
 */
async function findGainingSubject(
  domainName: string,
): Promise<TransferSubject | null> {
  const incoming = await db()
    .collection(COLLECTIONS.transfers)
    .where("domainName", "==", domainName)
    .where("direction", "==", "in")
    .get();
  const candidates = incoming.docs.map((doc) => doc.data() as TransferDoc);
  const chosen =
    candidates.find((data) => data.state === "pending") ?? candidates[0];
  if (!chosen) return null;
  return {uid: chosen.uid, registry: chosen.registry, direction: "in"};
}

/**
 * Works out which member a transfer notification is about, and on which side
 * of the transfer they stand.
 *
 * The registry only delivers a message to the registrar it concerns, so a
 * documented `op` already says which side we are on, and that decides which
 * lookup is even allowed to answer:
 *
 *   - `request` / `cancel` reach the **losing** side, so only a domain we
 *     actually hold can be the subject. Never falling through to the inbound
 *     records is the point: a request for a domain we do not hold used to be
 *     pinned on whichever member happened to have an inbound record for that
 *     name, which is the wrong member's transfer.
 *   - `approve` / `reject` reach the **gaining** side, so an inbound record is
 *     the answer. The owned-domain lookup is kept as a *second* choice only,
 *     because the registry is documented not to notify the losing side when
 *     the 20-minute clock auto-approves — if one ever does arrive, acting on
 *     it is strictly better than dropping it, and it is anchored to a domain
 *     we hold rather than guessed.
 *
 * A payload with no `op` cannot say, so it keeps the original order.
 *
 * @param {string} domainName Domain the notification is about.
 * @param {TransferDirection | null} documentedDirection Side the routing table
 *   implies, or null when the payload had no `op`.
 * @return {Promise<TransferSubject | null>} The member and direction, or null
 *   when the notification is about a domain that is nothing to do with us.
 */
async function resolveSubject(
  domainName: string,
  documentedDirection: TransferDirection | null,
): Promise<TransferSubject | null> {
  if (documentedDirection === "out") {
    return findLosingSubject(domainName);
  }
  if (documentedDirection === "in") {
    return (await findGainingSubject(domainName)) ??
      (await findLosingSubject(domainName));
  }
  return (await findLosingSubject(domainName)) ??
    (await findGainingSubject(domainName));
}

/**
 * Brings the domain mirror in line with a settled transfer.
 *
 * This is where a transfer-in actually becomes a domain the member can see:
 * once the registry says the transfer completed, `domain:info` is read and a
 * `domains/{uid}__{name}` record is written, which is what puts the name on
 * the list screen (FIG.9). The mirror needs `autoRenew` to be a real boolean
 * — `listDomains` rejects a record without one — so it is set explicitly
 * rather than left to default.
 *
 * Best effort: the transfer record is already correct, and an unreachable
 * registry must not undo that.
 *
 * @param {TransferSubject} subject Member and direction.
 * @param {string} domainName Domain the notification is about.
 * @param {TransferState} state State the transfer ended in.
 * @return {Promise<void>} Resolves once the mirror was updated, or skipped.
 */
async function syncMirror(
  subject: TransferSubject,
  domainName: string,
  state: TransferState,
): Promise<void> {
  const {uid, registry, direction} = subject;

  if (direction === "out" && state === "completed") {
    await syncDomainRecord(uid, domainName, null, {
      transferredAt: FieldValue.serverTimestamp(),
      autoRenew: false,
    });
    return;
  }

  // Nothing about an inbound transfer that has not completed changes what the
  // member owns, so there is no mirror to write yet.
  if (direction === "in" && state !== "completed") return;

  const client = getRegistryClient(registry);
  let info;
  try {
    info = await client.infoDomain(
      domainName,
      domainClTrid("INFO", domainName, Date.now().toString(36)),
    );
  } catch (error) {
    if (direction === "in" && state === "completed") {
      // The domain is ours now even if this one read failed; record it with
      // what is known so it is visible, and let the next info refresh fill
      // the registry fields in.
      logger.warn("transfer completed but domain:info failed; storing a stub",
        {uid, domainName, error: String(error)});
      await syncDomainRecord(uid, domainName, undefined, {
        lifecycle: "active",
        registry,
        status: [],
        rgpStatus: [],
        autoRenew: true,
      });
      return;
    }
    if (!isRegistryError(error)) throw error;
    logger.warn("could not refresh the domain mirror after a transfer event", {
      uid,
      domainName,
      error: error.message,
    });
    return;
  }

  await syncDomainRecord(uid, domainName, info, {
    registry,
    ...(direction === "in" && state === "completed" ? {autoRenew: true} : {}),
  });
}

/**
 * Processes one transfer notification.
 *
 * Exported for the tests, and because the poll worker's own contract is
 * `(message) => Promise<void>`.
 *
 * @param {PollMessage} message Message the worker stored and acked.
 * @return {Promise<void>} Resolves once the notification was applied.
 */
export async function handleTransferNotification(
  message: PollMessage,
): Promise<void> {
  const parsed = parseTransferNotification(message);
  if (!parsed) {
    // Stored and acked already; logging the raw type is what lets the real
    // shape be filled in later (README: "測って埋めること").
    logger.warn("transfer notification could not be parsed", {
      registry: message.registry,
      messageId: message.id,
      msgType: message.msgType,
      payloadKeys: Object.keys(message.payload ?? {}),
    });
    return;
  }

  const subject = await resolveSubject(
    parsed.domainName,
    parsed.documentedDirection,
  );
  if (!subject) {
    logger.info("transfer notification is about a domain we do not hold", {
      registry: message.registry,
      messageId: message.id,
      domainName: parsed.domainName,
      // Which side the message was addressed to, so a routing surprise is
      // visible in the log rather than only in a missing record.
      direction: parsed.documentedDirection,
    });
    return;
  }

  const state = STATE_FOR_EVENT[parsed.event];
  const registrars = registrarsFor(
    subject.direction,
    parsed,
    message.registry,
  );
  const outcome = await recordTransferNotification({
    uid: subject.uid,
    domainName: parsed.domainName,
    registry: subject.registry,
    direction: subject.direction,
    state,
    gainingRegistrar: registrars.gainingRegistrar,
    losingRegistrar: registrars.losingRegistrar,
    requestedAt: parsed.requestedAt,
    pollMessageId: `${message.registry}__${message.id}`,
  });

  if (outcome !== "written") {
    logger.info("transfer notification did not change the record", {
      messageId: message.id,
      domainName: parsed.domainName,
      outcome,
    });
    return;
  }

  await syncMirror(subject, parsed.domainName, state);
}

/**
 * Wires the transfer handler into the poll worker.
 *
 * Called at module load by everything that drains a queue (the scheduled
 * worker and the manual `drainPollQueue` Callable), so a drain can never run
 * with the handler missing. Registering the same handler twice is harmless —
 * the worker keys handlers by type.
 *
 * @return {void}
 */
export function registerTransferPollHandlers(): void {
  for (const msgType of TRANSFER_POLL_MSG_TYPES) {
    registerPollHandler(msgType, handleTransferNotification);
  }
}
