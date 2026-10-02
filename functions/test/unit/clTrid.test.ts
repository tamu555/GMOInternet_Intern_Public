/**
 * clTRID generation (spec 3.3).
 *
 * The point of these ids is that they are reproducible: the same order and
 * the same attempt always produce the same string, which is what lets the
 * team ask the registry "did ORD-000123-CREATE-01 go through?".
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  adhocClTrid,
  domainClTrid,
  orderClTrid,
  userClTrid,
} from "../../src/domain/clTrid";

describe("orderClTrid", () => {
  it("matches the format used in the spec", () => {
    assert.equal(orderClTrid(123, "CREATE", 1), "ORD-000123-CREATE-01");
  });

  it("is stable for the same order and attempt", () => {
    assert.equal(orderClTrid(7, "INFO", 2), orderClTrid(7, "INFO", 2));
  });

  it("changes when the attempt changes, so retries are distinguishable", () => {
    assert.notEqual(orderClTrid(7, "CREATE", 1), orderClTrid(7, "CREATE", 2));
  });

  it("zero-pads both the sequence and the attempt", () => {
    assert.equal(orderClTrid(1, "UPDATE", 9), "ORD-000001-UPDATE-09");
  });

  it("stays inside the 64 character recommendation", () => {
    assert.ok(orderClTrid(999999999, "CONTACT", 99).length <= 64);
  });
});

describe("userClTrid", () => {
  it("tags the registry so the two contact creates differ", () => {
    assert.equal(userClTrid(3, "CONTACT", "kitaqsign"),
      "USR-000003-CONTACT-KITAQSIGN");
    assert.notEqual(
      userClTrid(3, "CONTACT", "kitaqsign"),
      userClTrid(3, "CONTACT", "kitaqnic"),
    );
  });
});

describe("adhocClTrid", () => {
  it("prefixes non-order commands and upper-cases them", () => {
    assert.equal(adhocClTrid("SEARCH", "abc123"), "APP-SEARCH-ABC123");
  });

  it("truncates rather than exceeding the recommended length", () => {
    assert.ok(adhocClTrid("SEARCH", "x".repeat(200)).length === 64);
  });
});

describe("domainClTrid", () => {
  it("names the domain and the command", () => {
    assert.equal(domainClTrid("DELETE", "example.com", "abc"),
      "DOM-DELETE-EXAMPLE-COM-ABC");
  });

  it("keeps delete and restore apart for the same domain", () => {
    assert.notEqual(
      domainClTrid("DELETE", "example.com", "x"),
      domainClTrid("RESTORE", "example.com", "x"),
    );
  });

  it("keeps two runs of the same command apart", () => {
    assert.notEqual(
      domainClTrid("DELETE", "example.com", "aaa"),
      domainClTrid("DELETE", "example.com", "bbb"),
    );
  });

  it("stays inside the 64 character recommendation", () => {
    const long = `${"a".repeat(200)}.com`;
    assert.ok(domainClTrid("RESTORE", long, "zzzz").length === 64);
  });
});
