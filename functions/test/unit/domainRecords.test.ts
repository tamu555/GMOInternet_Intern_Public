/**
 * The pure parts of the `domains` record helpers.
 *
 * The life-cycle bucket is derived from the registry's own status arrays and
 * never from a local guess, which is what keeps the list screen honest
 * (spec 6.5). The distinction the tests below defend is the RGP one: a domain
 * is restorable while `redemptionPeriod` is present, *not* for the whole of
 * `pendingDelete` — the last five days of `pendingDelete` are the tail during
 * which `domain:restore` answers 2304 and the name is about to be purged.
 *
 * Where `redemptionPeriod` surfaces is deliberately not assumed: the status
 * table in the registries' `info.description` puts it in `status`, while
 * `DomainResponse.rgpStatus` describes RGP statuses as their own layer, so
 * both arrays are accepted.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  DomainNotOwnedError,
  domainDocId,
  isRestorable,
  lifecycleFromStatus,
} from "../../src/domain/domainRecords";

describe("isRestorable", () => {
  it("accepts redemptionPeriod in status", () => {
    assert.equal(
      isRestorable(["pendingDelete", "redemptionPeriod"], []), true);
  });

  it("accepts redemptionPeriod in rgpStatus", () => {
    assert.equal(
      isRestorable(["pendingDelete"], ["redemptionPeriod"]), true);
  });

  it("refuses pendingDelete on its own (the 5-day tail)", () => {
    assert.equal(isRestorable(["pendingDelete"], []), false);
  });

  it("does not fall over on missing arrays", () => {
    assert.equal(isRestorable(undefined, undefined), false);
  });
});

describe("lifecycleFromStatus", () => {
  it("treats a domain in redemptionPeriod as restorable", () => {
    assert.equal(
      lifecycleFromStatus(["pendingDelete"], ["redemptionPeriod"]),
      "pendingDelete",
    );
    assert.equal(
      lifecycleFromStatus(["pendingDelete", "redemptionPeriod"], []),
      "pendingDelete",
    );
  });

  it("still spots it alongside other statuses", () => {
    assert.equal(
      lifecycleFromStatus(["pendingDelete", "clientHold"],
        ["redemptionPeriod"]),
      "pendingDelete",
    );
  });

  it("treats pendingDelete without redemptionPeriod as past saving", () => {
    // The 45 days are over: restore answers 2304 and the name is purged five
    // days later, so this must not look like the restorable state.
    assert.equal(lifecycleFromStatus(["pendingDelete"], []), "gone");
  });

  it("treats everything else as active", () => {
    assert.equal(lifecycleFromStatus(["ok"], []), "active");
    assert.equal(lifecycleFromStatus(["inactive"], []), "active");
    assert.equal(lifecycleFromStatus(["pendingTransfer"], []), "active");
    assert.equal(lifecycleFromStatus(["ok"], ["autoRenewPeriod"]), "active");
  });

  it("does not fall over on a missing status array", () => {
    assert.equal(lifecycleFromStatus(undefined, undefined), "active");
    assert.equal(lifecycleFromStatus([], []), "active");
  });
});

describe("domainDocId", () => {
  it("scopes the id by member, so ownership is a point read", () => {
    assert.equal(domainDocId("uid1", "example.com"), "uid1__example.com");
  });

  it("gives two members different ids for the same name", () => {
    assert.notEqual(
      domainDocId("uid1", "example.com"),
      domainDocId("uid2", "example.com"),
    );
  });
});

describe("DomainNotOwnedError", () => {
  it("carries the domain name for the log line", () => {
    const error = new DomainNotOwnedError("example.com");
    assert.equal(error.domainName, "example.com");
    assert.ok(error instanceof Error);
  });
});
