/**
 * Maintenance announcements from the poll queue.
 *
 * Neither registry documents a maintenance message — the OpenAPI documents
 * name exactly one `msgType`, `domain:transfer` — but the operators can put
 * one on the queue before a window starts, and that advance notice is the
 * only signal strong enough to let the UI say "メンテナンス中"
 * (docs/仕様/registry-unavailable.md; a 503 alone is forbidden to make that
 * claim). So this module is written the way transferNotifications.ts treats
 * *its* undocumented shapes: claim the message family by keyword, read the
 * fields defensively, keep the raw payload, and log what could not be
 * understood so the real shape can be filled in once one is observed.
 *
 * What a notification is expected to look like, loosely:
 *
 * ```json
 * { "id": 57, "msgType": "registry:maintenance",
 *   "payload": { "start": "2026-08-30T01:00:00Z",
 *                "end":   "2026-08-30T03:00:00Z",
 *                "message": "定期メンテナンス" },
 *   "qdate": "2026-08-27T09:00:00" }
 * ```
 *
 * Every field is optional in practice. A message that reads as
 * end-of-maintenance clears the standing record; anything else records (or
 * replaces) the announced window in registryMaintenance.ts, which is what
 * the EppClient gate and the poll worker act on.
 */
import * as logger from "firebase-functions/logger";
import {
  clearMaintenance,
  setMaintenance,
} from "../bridge/registryMaintenance";
import type {PollMessage} from "../bridge/types";
import {
  normalisePollMsgType,
  registerPollHandler,
  registerPollHandlerFallback,
} from "./pollWorker";

/**
 * Message types this module claims by exact (punctuation-insensitive) match.
 *
 * Plausible spellings only — the real one is undocumented. The keyword
 * fallback below is what actually guarantees coverage; these entries exist
 * so the expected spellings are visible in one place.
 */
export const MAINTENANCE_POLL_MSG_TYPES = [
  "registry:maintenance",
  "system:maintenance",
  "maintenance",
  "maintenance:start",
  "maintenance:scheduled",
  "maintenance:notice",
  "maintenance:end",
  "maintenance:complete",
] as const;

/**
 * Keyword net for any spelling the exact list missed. Applied to the raw
 * `msgType` (normalisation strips non-ASCII, so 日本語 must be matched here).
 */
export const MAINTENANCE_MSG_PATTERN = /mainten|メンテ|保守/i;

/** Payload keys that may nest the real body one level down. */
const NESTED_KEYS = [
  "resData", "data", "payload", "message",
  "maintenance", "window", "schedule", "period", "details", "notice",
];

/** Payload keys that may say which phase the notification reports. */
const PHASE_KEYS = ["op", "status", "phase", "event", "state", "action"];

/** Payload keys that may hold the announced start, most specific first. */
const START_KEYS = [
  "windowStart", "startAt", "startsAt", "startTime", "startDate",
  "scheduledStart", "start", "from", "beginAt", "begin",
];

/** Payload keys that may hold the announced end, most specific first. */
const END_KEYS = [
  "windowEnd", "endAt", "endsAt", "endTime", "endDate", "scheduledEnd",
  "resumeAt", "resumesAt", "finishAt", "expiresAt",
  "end", "until", "till",
];

/** Payload keys that may hold free text worth keeping. */
const NOTE_KEYS = [
  "message", "msg", "note", "text", "description", "detail", "reason",
  "title",
];

/** What one notification reports. */
export interface ParsedMaintenanceNotification {
  /** "end" clears the record; "start" records the window. */
  phase: "start" | "end";
  windowStart: Date | null;
  windowEnd: Date | null;
  note: string | null;
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
 * Reads one timestamp-ish value, tolerating the formats a registry might
 * plausibly use: ISO 8601 (with or without zone), "YYYY-MM-DD hh:mm", and
 * epoch seconds or milliseconds.
 *
 * @param {unknown} value Raw payload value.
 * @return {Date | null} Parsed instant, or null when unreadable.
 */
function parseWhen(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: 1e12 is 2001 in ms and ~33658 in s, so it splits the two
    // encodings safely for any plausible maintenance date.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  let ms = Date.parse(text);
  if (Number.isNaN(ms)) ms = Date.parse(text.replace(" ", "T"));
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Reads a Date out of an untyped payload, trying several keys.
 *
 * @param {Record<string, unknown>} payload Flattened payload.
 * @param {string[]} keys Candidate field names, in priority order.
 * @return {Date | null} First parseable value found.
 */
function pickWhen(
  payload: Record<string, unknown>,
  keys: string[],
): Date | null {
  for (const key of keys) {
    const parsed = parseWhen(payload[key]);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Words that report maintenance being over. Matched cautiously: bare "end"
 * only as an exact word or type suffix, because "extended" also contains it
 * and a 延長 notice read as an ending would reopen traffic mid-window.
 *
 * @param {string} source Lower-cased words to inspect.
 * @return {boolean} True when the source reports an ending.
 */
function readsAsEnd(source: string): boolean {
  if (!source) return false;
  if (/finish|complete|resume|recover|lift|cancel/i.test(source)) return true;
  return source === "end" || source === "ended" || source.endsWith("end");
}

/**
 * Turns a raw poll message into the facts this module needs.
 *
 * Never returns null on purpose: the handler is only invoked for messages
 * already matched as maintenance-ish, and a payload nothing could be read
 * from still means "the registry announced maintenance" — an empty window
 * (probed every 30s) is the honest reading of that.
 *
 * @param {PollMessage} message Message as the worker received it.
 * @return {ParsedMaintenanceNotification} Parsed facts.
 */
export function parseMaintenanceNotification(
  message: PollMessage,
): ParsedMaintenanceNotification {
  const payload = flatten(message.payload ?? {});

  const phaseWord = pickString(payload, PHASE_KEYS)?.toLowerCase() ?? "";
  const typeWords = normalisePollMsgType(message.msgType);
  const phase =
    readsAsEnd(phaseWord) || (!phaseWord && readsAsEnd(typeWords)) ?
      "end" :
      "start";

  return {
    phase,
    windowStart: pickWhen(payload, START_KEYS),
    windowEnd: pickWhen(payload, END_KEYS),
    note: pickString(payload, NOTE_KEYS),
  };
}

/**
 * Processes one maintenance notification.
 *
 * Exported for the tests, and because the poll worker's own contract is
 * `(message) => Promise<void>`.
 *
 * @param {PollMessage} message Message the worker stored and acked.
 * @return {Promise<void>} Resolves once the state was updated.
 */
export async function handleMaintenanceNotification(
  message: PollMessage,
): Promise<void> {
  const parsed = parseMaintenanceNotification(message);

  if (parsed.phase === "end") {
    await clearMaintenance(message.registry, "notification");
    return;
  }

  if (!parsed.windowStart && !parsed.windowEnd) {
    // Stored and acked already; logging the raw shape is what lets the real
    // field names be filled in later (README: "測って埋めること").
    logger.warn("maintenance notification carried no window times", {
      registry: message.registry,
      messageId: message.id,
      msgType: message.msgType,
      payloadKeys: Object.keys(message.payload ?? {}),
    });
  }

  await setMaintenance(message.registry, {
    windowStart: parsed.windowStart,
    windowEnd: parsed.windowEnd,
    msgId: message.id,
    msgType: message.msgType,
    note: parsed.note,
    rawPayload: message.payload ?? null,
  });
}

/**
 * Wires the maintenance handler into the poll worker.
 *
 * Called at module load by everything that drains a queue (the scheduled
 * worker and the manual `drainPollQueue` Callable), so a drain can never run
 * with the handler missing. Registering twice is harmless.
 *
 * @return {void}
 */
export function registerMaintenancePollHandlers(): void {
  for (const msgType of MAINTENANCE_POLL_MSG_TYPES) {
    registerPollHandler(msgType, handleMaintenanceNotification);
  }
  registerPollHandlerFallback(
    (msgType) => MAINTENANCE_MSG_PATTERN.test(msgType),
    handleMaintenanceNotification,
  );
}
