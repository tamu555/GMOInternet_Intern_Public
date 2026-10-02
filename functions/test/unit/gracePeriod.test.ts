/**
 * The restore deadline behind 「あと◯日は戻せます」 (spec 3.5).
 *
 * The registries report no deadline of their own, so this arithmetic is the
 * only thing standing between the member and a screen that offers a restore
 * which cannot work any more.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_GRACE_PERIOD_DAYS,
  restorableUntilOf,
} from "../../src/domain/gracePeriod";

describe("restorableUntilOf", () => {
  it("adds kitaqnic's documented 45 days to the delete", () => {
    assert.equal(
      restorableUntilOf("kitaqnic", new Date("2026-03-01T09:00:00Z")),
      "2026-04-15T09:00:00.000Z",
    );
  });

  it("assumes the same window for kitaqsign until テスト3 measures it", () => {
    assert.equal(
      RESTORE_GRACE_PERIOD_DAYS.kitaqsign,
      RESTORE_GRACE_PERIOD_DAYS.kitaqnic,
    );
  });

  it("is a deadline in the future, not a duration", () => {
    const deletedAt = new Date("2026-03-01T00:00:00Z");
    assert.ok(
      new Date(restorableUntilOf("kitaqsign", deletedAt)) > deletedAt,
    );
  });
});
