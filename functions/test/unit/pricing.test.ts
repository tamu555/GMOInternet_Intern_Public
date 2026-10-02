/**
 * Price lookup.
 *
 * The amounts are placeholders (TBD #7). What is worth locking down is that
 * the price is derived on the server from the TLD and the period, so a client
 * cannot dictate what it pays, and that a multi-year registration is priced
 * as first year + renewal price per following year (the same formula the
 * confirm screen displays).
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  priceForRegistration,
  priceForRestore,
} from "../../src/domain/pricing";

describe("priceForRegistration", () => {
  it("prices per TLD", () => {
    assert.equal(priceForRegistration("example.com", 1), 1480);
    assert.equal(priceForRegistration("example.info", 1), 980);
    assert.equal(priceForRegistration("example.xyz", 1), 98);
  });

  it("charges first year + renewal for each following year", () => {
    // .com: 1480 first year + 1980 × 2 renewal years.
    assert.equal(priceForRegistration("example.com", 3), 1480 + 1980 * 2);
  });

  it("falls back to a default for an unlisted TLD", () => {
    assert.equal(priceForRegistration("example.invalid", 1), 1500);
  });
});

describe("priceForRestore", () => {
  it("prices per TLD", () => {
    assert.equal(priceForRestore("example.com"), 3300);
    assert.equal(priceForRestore("example.ceo"), 4400);
  });

  it("falls back to a default for an unlisted TLD", () => {
    assert.equal(priceForRestore("example.invalid"), 8000);
  });

  it("costs more than a year of registration", () => {
    // The whole reason the spec rejects a recycle-bin metaphor: getting a
    // deleted domain back is not free (spec 6.5).
    assert.ok(
      priceForRestore("example.com") > priceForRegistration("example.com", 1),
    );
  });
});
