/**
 * Parsing transfer poll notifications (spec 6.6 / 3.7).
 *
 * Both registries now document the message: `msgType: "domain:transfer"` with
 * `payload: {op, domain, counterpartyRegistrar}`, where `op` says both what
 * happened and — through the registry's delivery rules — which side of the
 * transfer we are on. The first block below pins that down.
 *
 * The rest is the tolerance the parser keeps for a payload without an `op`:
 * `msgType` is still typed as a free string, so a per-operation spelling has
 * to keep working rather than becoming "unhandled". If somebody later narrows
 * the parser, the spellings it stops accepting fail here.
 *
 * No I/O: `parseTransferNotification` is pure, and the deadline helper is
 * arithmetic.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import type {PollMessage} from "../../src/bridge/types";
import {normalisePollMsgType} from "../../src/domain/pollWorker";
import {
  parseTransferNotification,
} from "../../src/domain/transferNotifications";
import {
  autoApproveDeadline,
  TRANSFER_AUTO_APPROVE_MS,
} from "../../src/domain/transfers";

/**
 * Builds a poll message with the given type and payload.
 *
 * @param {string} msgType Message type as a registry might spell it.
 * @param {Record<string, unknown>} payload Message payload.
 * @return {PollMessage} Message as the poll worker would hand it over.
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
    qdate: "2026-08-26T10:00:00Z",
    queueSize: 1,
  };
}

describe("normalisePollMsgType", () => {
  it("folds the spellings a registry might plausibly use together", () => {
    const key = normalisePollMsgType("transfer.request");
    for (const variant of [
      "TRANSFER_REQUEST",
      "transferRequest",
      "Transfer-Request",
      "transfer:request",
      "  transfer request  ",
    ]) {
      assert.equal(normalisePollMsgType(variant), key, variant);
    }
  });

  it("still keeps genuinely different types apart", () => {
    assert.notEqual(
      normalisePollMsgType("transfer.request"),
      normalisePollMsgType("transfer.approve"),
    );
  });
});

describe("parseTransferNotification: the documented shape", () => {
  /**
   * Builds the message the registries document, for one operation.
   *
   * @param {string} op Value of `payload.op`.
   * @return {PollMessage} Message as the poll worker would hand it over.
   */
  function documented(op: string): PollMessage {
    return message("domain:transfer", {
      op,
      domain: "example.com",
      counterpartyRegistrar: "teamb",
    });
  }

  it("reads the four events off payload.op", () => {
    const cases: Array<[string, string]> = [
      ["request", "requested"],
      ["approve", "approved"],
      ["reject", "rejected"],
      ["cancel", "cancelled"],
    ];
    for (const [op, event] of cases) {
      assert.equal(parseTransferNotification(documented(op))?.event, event, op);
    }
  });

  it("derives which side we are on from op (registry routing table)", () => {
    // request / cancel are delivered to the losing registrar, approve /
    // reject to the gaining one — so the op fixes our direction.
    assert.equal(
      parseTransferNotification(documented("request"))?.documentedDirection,
      "out");
    assert.equal(
      parseTransferNotification(documented("cancel"))?.documentedDirection,
      "out");
    assert.equal(
      parseTransferNotification(documented("approve"))?.documentedDirection,
      "in");
    assert.equal(
      parseTransferNotification(documented("reject"))?.documentedDirection,
      "in");
  });

  it("keeps counterpartyRegistrar relative, not a fixed side", () => {
    const parsed = parseTransferNotification(documented("request"));
    assert.equal(parsed?.counterpartyRegistrar, "teamb");
    // Deliberately NOT resolved here: which side "teamb" is on depends on
    // the direction, and our own id is not a parsing concern.
    assert.equal(parsed?.gainingRegistrar, null);
    assert.equal(parsed?.losingRegistrar, null);
  });

  it("never reads a request as an approval, whatever else is in the payload",
    () => {
      // The pre-`op` heuristic matched "approve" anywhere in the message.
      const parsed = parseTransferNotification(
        message("domain:transfer", {
          op: "request",
          domain: "example.com",
          counterpartyRegistrar: "teamb",
          status: "pendingApproval",
        }),
      );
      assert.equal(parsed?.event, "requested");
    });

  it("refuses an op it does not know rather than guessing", () => {
    assert.equal(parseTransferNotification(documented("frobnicate")), null);
  });

  it("takes op over a message type that says something else", () => {
    // A registry that spells the operation into the type *and* sends an op
    // must not be read two ways; the documented field wins.
    const parsed = parseTransferNotification(
      message("transfer.request", {op: "reject", domain: "example.com"}),
    );
    assert.equal(parsed?.event, "rejected");
    assert.equal(parsed?.documentedDirection, "in");
  });
});

describe("parseTransferNotification: payloads without an op", () => {
  it("reads the four events off the message type", () => {
    const cases: Array<[string, string]> = [
      ["transfer.request", "requested"],
      ["TRANSFER_APPROVE", "approved"],
      ["domain:transfer:reject", "rejected"],
      ["transferCancel", "cancelled"],
    ];
    for (const [msgType, event] of cases) {
      const parsed = parseTransferNotification(
        message(msgType, {domain: "example.com"}),
      );
      assert.equal(parsed?.event, event, msgType);
    }
  });

  it("falls back to a payload status when the type is unspecific", () => {
    const parsed = parseTransferNotification(
      message("domain:transfer", {
        domain: "example.com",
        status: "clientApproved",
      }),
    );
    assert.equal(parsed?.event, "approved");
  });

  it("accepts the domain under any of the likely keys", () => {
    for (const key of ["domain", "domainName", "name", "objId"]) {
      const parsed = parseTransferNotification(
        message("transfer.request", {[key]: "example.com"}),
      );
      assert.equal(parsed?.domainName, "example.com", key);
    }
  });

  it("finds a payload nested one level down", () => {
    const parsed = parseTransferNotification(
      message("transfer.request", {
        resData: {domain: "example.com", gainingRegistrar: "KITAQ-THEM"},
      }),
    );
    assert.equal(parsed?.domainName, "example.com");
    assert.equal(parsed?.gainingRegistrar, "KITAQ-THEM");
  });

  it("leaves the direction unknown, so the caller has to work it out", () => {
    const parsed = parseTransferNotification(
      message("transfer.request", {domain: "example.com"}),
    );
    assert.equal(parsed?.documentedDirection, null);
  });

  it("lower-cases the domain name so it matches our stored keys", () => {
    const parsed = parseTransferNotification(
      message("transfer.request", {domain: "EXAMPLE.COM"}),
    );
    assert.equal(parsed?.domainName, "example.com");
  });

  it("stamps the request time from our own clock, not the payload", () => {
    // Kitaqsign omits the zone from `reDate` and kitaqnic labels JST as `Z`,
    // so neither the payload nor `qdate` can be trusted for the deadline.
    const before = Date.now();
    const parsed = parseTransferNotification(
      message("transfer.request", {
        domain: "example.com",
        reDate: "2026-08-26T09:00:00Z",
      }),
    );
    const at = Date.parse(parsed?.requestedAt ?? "");
    assert.ok(at >= before && at <= Date.now() + 1000);
  });

  it("refuses a transfer message with no domain in it", () => {
    // Better to log the raw payload than to act on a guessed domain name.
    assert.equal(
      parseTransferNotification(message("transfer.request", {})),
      null,
    );
  });

  it("ignores messages that are not about transfer at all", () => {
    assert.equal(
      parseTransferNotification(
        message("domain.expiring", {domain: "example.com"}),
      ),
      null,
    );
  });
});

describe("autoApproveDeadline", () => {
  it("is 20 minutes after the request (spec 6.6.1)", () => {
    const requestedAt = "2026-08-26T10:00:00.000Z";
    assert.equal(
      autoApproveDeadline(requestedAt),
      new Date(Date.parse(requestedAt) + TRANSFER_AUTO_APPROVE_MS)
        .toISOString(),
    );
    assert.equal(TRANSFER_AUTO_APPROVE_MS, 20 * 60 * 1000);
  });

  it("is null when the request time is missing or unparseable", () => {
    assert.equal(autoApproveDeadline(null), null);
    assert.equal(autoApproveDeadline("not a date"), null);
  });
});
