/**
 * The poll worker (spec 3.7, FIG.3).
 *
 * The registry queues asynchronous notifications — a transfer request landing
 * on one of our domains, for example — and hands them out one at a time,
 * oldest first. Nothing newer arrives until the current message is acked, so
 * a single unacked message stops every later notification for that registry.
 * That is why this runs in the background on a schedule rather than when
 * somebody happens to open a screen.
 *
 * Each message is handled in a fixed order, and the order is the whole point:
 *
 *   1. persist   — if this fails we do not ack, so the registry redelivers
 *   2. ack       — the queue can now move on
 *   3. handle    — business processing, best effort
 *
 * Doing (3) before (2) would mean a handler bug stops the queue for everyone.
 * Doing (2) before (1) would mean a crash loses the notification for good.
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_IDS, type RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import {isRegistryError} from "../bridge/errors";
import type {PollMessage} from "../bridge/types";
import {adhocClTrid} from "./clTrid";

/** Business processing for one kind of message. */
export type PollMessageHandler = (message: PollMessage) => Promise<void>;

const handlers = new Map<string, PollMessageHandler>();

/** A handler matched by predicate, tried after the exact-type lookup. */
interface FallbackHandler {
  test: (msgType: string) => boolean;
  handler: PollMessageHandler;
}

const fallbackHandlers: FallbackHandler[] = [];

/**
 * Folds a message type down to its letters, lower-cased.
 *
 * Both registries now document one transfer type — `domain:transfer`, with
 * the operation in `payload.op` (spec 3.7) — but the field is still typed as
 * a free `string`, and one registry spelling it `DOMAIN_TRANSFER` would
 * silently leave every transfer notification unhandled. Punctuation and
 * casing are therefore ignored on both sides of the lookup and only the
 * letters have to agree, so `domain:transfer`, `domain.transfer` and
 * `DOMAIN_TRANSFER` all reach the same handler.
 *
 * @param {string} msgType Message type as the registry spells it.
 * @return {string} Comparable key.
 */
export function normalisePollMsgType(msgType: string): string {
  return msgType.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Registers the handler for one `msgType`.
 *
 * Matching ignores case and punctuation (see {@link normalisePollMsgType}).
 * A type nobody registers is still stored and acked, and its type logged, so
 * the queue keeps moving and nothing is lost.
 *
 * @param {string} msgType Message type as the registry spells it.
 * @param {PollMessageHandler} handler Processing for that type.
 */
export function registerPollHandler(
  msgType: string,
  handler: PollMessageHandler,
): void {
  handlers.set(normalisePollMsgType(msgType), handler);
}

/**
 * Registers a handler matched by predicate rather than exact type.
 *
 * Tried only when no exact `msgType` registration matches, in registration
 * order. This is what lets a message family whose exact spelling is
 * undocumented — a maintenance notice, say — be claimed by keyword without
 * enumerating every spelling a registry might invent.
 *
 * @param {function(string): boolean} test Predicate over the raw msgType.
 * @param {PollMessageHandler} handler Processing for matching messages.
 */
export function registerPollHandlerFallback(
  test: (msgType: string) => boolean,
  handler: PollMessageHandler,
): void {
  // Registering twice is harmless, like registerPollHandler: everything that
  // drains a queue registers at module load, and both entry points share one
  // process.
  if (fallbackHandlers.some((entry) => entry.handler === handler)) return;
  fallbackHandlers.push({test, handler});
}

/** Removes every registered handler. Test helper. */
export function clearPollHandlers(): void {
  handlers.clear();
  fallbackHandlers.length = 0;
}

/** How a drain run ended. */
export type DrainStop =
  /** The registry reported an empty queue. */
  | "empty"
  /** Hit the per-run message cap; more are waiting. */
  | "limit"
  /** The same message came back twice: the queue is not moving. */
  | "stuck"
  /** A poll, a persist or an ack failed. */
  | "error"
  /** Skipped: the registry announced maintenance and the window is on. */
  | "maintenance";

/** What one drain run did. */
export interface DrainResult {
  registry: RegistryId;
  polled: number;
  acked: number;
  /** Messages stored and acked whose handler threw. */
  handlerFailures: number;
  /** Unacked messages the registry still reported, after the last ack. */
  remaining: number;
  stoppedBecause: DrainStop;
  error?: string;
}

/** Options for one drain run. */
export interface DrainOptions {
  /** Upper bound on messages per run, so one tick cannot run forever. */
  maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 25;

/**
 * Firestore id for a poll message. Scoped by registry because the two
 * registries number their queues independently.
 *
 * @param {RegistryId} registry Registry the message came from.
 * @param {string} id Registry-assigned message id.
 * @return {string} Firestore document id.
 */
export function pollMessageDocId(
  registry: RegistryId,
  id: string,
): string {
  return `${registry}__${id}`;
}

/**
 * Stores a message before it is acked.
 *
 * Uses the registry's own id, so a redelivery after a failed ack updates the
 * same document instead of creating a duplicate.
 *
 * @param {PollMessage} message Message to store.
 * @return {Promise<void>} Resolves once written.
 */
async function persistMessage(message: PollMessage): Promise<void> {
  await db()
    .collection(COLLECTIONS.pollMessages)
    .doc(pollMessageDocId(message.registry, message.id))
    .set(
      {
        registry: message.registry,
        messageId: message.id,
        msgType: message.msgType,
        payload: message.payload,
        qdate: message.qdate,
        queueSize: message.queueSize,
        acked: false,
        handled: "pending",
        receivedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
}

/**
 * Records the outcome of one message once it has been acked and handled.
 *
 * @param {PollMessage} message Message that was processed.
 * @param {string} handled Outcome label.
 * @param {string | undefined} handlerError Error text, when one was thrown.
 * @return {Promise<void>} Resolves once written.
 */
async function recordOutcome(
  message: PollMessage,
  handled: "done" | "failed" | "unhandled",
  handlerError?: string,
): Promise<void> {
  await db()
    .collection(COLLECTIONS.pollMessages)
    .doc(pollMessageDocId(message.registry, message.id))
    .set(
      {
        acked: true,
        ackedAt: FieldValue.serverTimestamp(),
        handled,
        handlerError: handlerError ?? null,
      },
      {merge: true},
    );
}

/**
 * Runs the registered handler, if there is one, without letting a failure
 * escape. The message is already durable and acked by this point.
 *
 * @param {PollMessage} message Message to process.
 * @return {Promise<boolean>} False when the handler threw.
 */
async function handleMessage(message: PollMessage): Promise<boolean> {
  const handler = handlers.get(normalisePollMsgType(message.msgType)) ??
    fallbackHandlers.find((entry) => entry.test(message.msgType))?.handler;
  if (!handler) {
    logger.info("no handler for poll message type", {
      registry: message.registry,
      msgType: message.msgType,
      messageId: message.id,
    });
    await recordOutcome(message, "unhandled");
    return true;
  }

  try {
    await handler(message);
    await recordOutcome(message, "done");
    return true;
  } catch (error) {
    // Deliberately swallowed: the message is stored, so it can be retried
    // from Firestore. Rethrowing here would stop the queue for everyone.
    logger.error("poll handler failed", {
      registry: message.registry,
      msgType: message.msgType,
      messageId: message.id,
      error: String(error),
    });
    await recordOutcome(message, "failed", String(error));
    return false;
  }
}

/**
 * Drains one registry's queue: poll, store, ack, handle, repeat.
 *
 * @param {RegistryId} registry Registry to drain.
 * @param {DrainOptions} options Per-run limits.
 * @return {Promise<DrainResult>} What the run did.
 */
export async function drainRegistryQueue(
  registry: RegistryId,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const client = getRegistryClient(registry);
  const result: DrainResult = {
    registry,
    polled: 0,
    acked: 0,
    handlerFailures: 0,
    remaining: 0,
    stoppedBecause: "empty",
  };

  let previousId: string | undefined;

  for (let i = 0; i < maxMessages; i++) {
    let message: PollMessage | null;
    try {
      message = await client.pollMessage(
        adhocClTrid("POLL", `${registry}-${i}`),
      );
    } catch (error) {
      // Announced maintenance is expected, not a fault: during the window
      // the poll endpoint answers 503 like everything else, so the client
      // gate fails the request fast and this run is labelled rather than
      // logged as an error. Once the announced end passes the gate lets the
      // next poll through, and that poll doubles as the recovery probe.
      if (isRegistryError(error) && error.maintenance) {
        result.stoppedBecause = "maintenance";
        logger.info("poll skipped: registry announced maintenance", {
          registry,
          until: error.maintenanceUntil,
        });
        return result;
      }
      result.stoppedBecause = "error";
      result.error = isRegistryError(error) ? error.message : String(error);
      logger.error("poll:req failed", {registry, error: result.error});
      return result;
    }

    if (!message) {
      result.stoppedBecause = "empty";
      result.remaining = 0;
      return result;
    }

    // The registry always returns the oldest unacked message. Seeing the same
    // id twice means our ack did not take effect, and looping would just
    // re-read it until the run's cap (spec 3.7).
    if (message.id === previousId) {
      result.stoppedBecause = "stuck";
      result.remaining = message.queueSize;
      logger.error("poll queue is not advancing", {
        registry,
        messageId: message.id,
      });
      return result;
    }
    previousId = message.id;
    result.polled++;

    try {
      await persistMessage(message);
    } catch (error) {
      // Not acked on purpose: the registry will hand it to us again.
      result.stoppedBecause = "error";
      result.error = String(error);
      result.remaining = message.queueSize;
      logger.error("could not store poll message, leaving it unacked", {
        registry,
        messageId: message.id,
        error: result.error,
      });
      return result;
    }

    try {
      await client.ackMessage(
        message.id,
        adhocClTrid("ACK", `${registry}-${message.id}`),
      );
    } catch (error) {
      result.stoppedBecause = "error";
      result.error = isRegistryError(error) ? error.message : String(error);
      result.remaining = message.queueSize;
      logger.error("poll:ack failed, queue is blocked", {
        registry,
        messageId: message.id,
        error: result.error,
      });
      return result;
    }
    result.acked++;
    result.remaining = Math.max(0, message.queueSize - 1);

    if (!(await handleMessage(message))) {
      result.handlerFailures++;
    }
  }

  result.stoppedBecause = "limit";
  // Never let a cap look like an empty queue.
  logger.warn("poll run hit its message cap", {
    registry,
    maxMessages,
    remaining: result.remaining,
  });
  return result;
}

/**
 * Drains every registry.
 *
 * The registries are drained independently: one being unreachable must not
 * stop the other's notifications.
 *
 * @param {DrainOptions} options Per-run limits.
 * @return {Promise<DrainResult[]>} One result per registry.
 */
export async function drainAllQueues(
  options: DrainOptions = {},
): Promise<DrainResult[]> {
  const runs = await Promise.allSettled(
    REGISTRY_IDS.map((registry) => drainRegistryQueue(registry, options)),
  );

  return runs.map((run, index) =>
    run.status === "fulfilled" ?
      run.value :
      {
        registry: REGISTRY_IDS[index],
        polled: 0,
        acked: 0,
        handlerFailures: 0,
        remaining: 0,
        stoppedBecause: "error" as const,
        error: String(run.reason),
      },
  );
}
