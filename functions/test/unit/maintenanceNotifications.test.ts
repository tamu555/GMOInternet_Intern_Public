/**
 * Parsing of the (undocumented) maintenance poll message.
 *
 * Neither OpenAPI document specifies this message, so the parser is a
 * keyword-and-guesswork one, like transferNotifications' fallback path. What
 * is worth pinning down is exactly the guesswork: which spellings are
 * claimed, which payload fields yield the window, and that an ending is
 * never misread — a 延長 (extended) notice read as "maintenance over" would
 * reopen traffic mid-window.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  MAINTENANCE_MSG_PATTERN,
  parseMaintenanceNotification,
} from "../../src/domain/maintenanceNotifications";
import type {PollMessage} from "../../src/bridge/types";

/**
 * A poll message with the given type and payload.
 *
 * @param {string} msgType Message type as the registry would spell it.
 * @param {Record<string, unknown>} payload Message payload.
 * @return {PollMessage} Message as the worker would hand it over.
 */
function message(
  msgType: string,
  payload: Record<string, unknown>,
): PollMessage {
  return {
    id: "1",
    registry: "kitaqsign",
    msgType,
    payload,
    qdate: "2026-08-27T09:00:00",
    queueSize: 1,
  };
}

describe("maintenanceNotifications: keyword net", () => {
  it("claims plausible spellings, English and Japanese", () => {
    for (const msgType of [
      "registry:maintenance",
      "MAINTENANCE_NOTICE",
      "system.maintenance.scheduled",
      "メンテナンスのお知らせ",
      "定期保守",
    ]) {
      assert.ok(MAINTENANCE_MSG_PATTERN.test(msgType), msgType);
    }
  });

  it("does not claim unrelated messages", () => {
    for (const msgType of ["domain:transfer", "domain:renew", "billing"]) {
      assert.ok(!MAINTENANCE_MSG_PATTERN.test(msgType), msgType);
    }
  });
});

describe("maintenanceNotifications: window parsing", () => {
  it("reads an ISO start/end pair from the documented-ish shape", () => {
    const parsed = parseMaintenanceNotification(message(
      "registry:maintenance",
      {start: "2026-08-30T01:00:00Z", end: "2026-08-30T03:00:00Z"},
    ));
    assert.equal(parsed.phase, "start");
    assert.equal(parsed.windowStart?.toISOString(), "2026-08-30T01:00:00.000Z");
    assert.equal(parsed.windowEnd?.toISOString(), "2026-08-30T03:00:00.000Z");
  });

  it("prefers the specific field names over the generic ones", () => {
    const parsed = parseMaintenanceNotification(message(
      "maintenance",
      {
        windowStart: "2026-08-30T01:00:00Z",
        windowEnd: "2026-08-30T03:00:00Z",
        start: "1999-01-01T00:00:00Z",
        end: "1999-01-01T01:00:00Z",
      },
    ));
    assert.equal(parsed.windowStart?.toISOString(), "2026-08-30T01:00:00.000Z");
    assert.equal(parsed.windowEnd?.toISOString(), "2026-08-30T03:00:00.000Z");
  });

  it("reads a body nested one level down", () => {
    const parsed = parseMaintenanceNotification(message(
      "registry:maintenance",
      {maintenance: {
        from: "2026-08-30T01:00:00Z",
        until: "2026-08-30T03:00:00Z",
        message: "定期メンテナンス",
      }},
    ));
    assert.equal(parsed.windowStart?.toISOString(), "2026-08-30T01:00:00.000Z");
    assert.equal(parsed.windowEnd?.toISOString(), "2026-08-30T03:00:00.000Z");
    assert.equal(parsed.note, "定期メンテナンス");
  });

  it("tolerates epoch seconds and milliseconds", () => {
    const seconds = parseMaintenanceNotification(message(
      "maintenance", {end: 1_790_000_000},
    ));
    assert.equal(seconds.windowEnd?.getTime(), 1_790_000_000_000);
    const millis = parseMaintenanceNotification(message(
      "maintenance", {end: 1_790_000_000_000},
    ));
    assert.equal(millis.windowEnd?.getTime(), 1_790_000_000_000);
  });

  it("tolerates a space where ISO wants a T", () => {
    const parsed = parseMaintenanceNotification(message(
      "maintenance", {end: "2026-08-30 03:00:00Z"},
    ));
    assert.equal(parsed.windowEnd?.toISOString(), "2026-08-30T03:00:00.000Z");
  });

  it("yields an empty window when nothing is readable", () => {
    const parsed = parseMaintenanceNotification(message(
      "maintenance", {end: "そのうち"},
    ));
    assert.equal(parsed.phase, "start");
    assert.equal(parsed.windowStart, null);
    assert.equal(parsed.windowEnd, null);
  });
});

describe("maintenanceNotifications: phase", () => {
  it("reads an ending from the payload discriminator", () => {
    for (const status of ["end", "ended", "completed", "finished", "resumed",
      "cancelled"]) {
      const parsed = parseMaintenanceNotification(message(
        "registry:maintenance", {status},
      ));
      assert.equal(parsed.phase, "end", status);
    }
  });

  it("reads an ending from the type when the payload says nothing", () => {
    const parsed = parseMaintenanceNotification(message(
      "maintenance:end", {},
    ));
    assert.equal(parsed.phase, "end");
  });

  it("never reads 'extended' as an ending", () => {
    // 「延長」を「終了」と誤読すると窓の途中でトラフィックを再開してしまう。
    const parsed = parseMaintenanceNotification(message(
      "registry:maintenance",
      {status: "extended", end: "2026-08-30T05:00:00Z"},
    ));
    assert.equal(parsed.phase, "start");
  });

  it("a payload discriminator outranks the type", () => {
    const parsed = parseMaintenanceNotification(message(
      "maintenance:end", {status: "scheduled"},
    ));
    assert.equal(parsed.phase, "start");
  });
});
