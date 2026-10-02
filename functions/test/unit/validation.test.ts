/**
 * Input constraints (spec 3.4).
 *
 * These are the rules that make the difference between a form that works and
 * one that returns HTTP 400 every time, so each one is pinned down here.
 */
import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_CONTACT_NAMES,
  buildContactEmail,
  normaliseContactName,
  normaliseDomainName,
  normaliseNameservers,
  normalisePeriodYears,
  validateAuthInfo,
  ValidationError,
} from "../../src/domain/validation";

describe("normaliseDomainName", () => {
  it("lower-cases, trims and drops the root dot", () => {
    assert.equal(normaliseDomainName("  Example.COM.  "), "example.com");
  });

  it("accepts hyphens inside a label", () => {
    assert.equal(normaliseDomainName("my-shop.net"), "my-shop.net");
  });

  it("rejects an empty name", () => {
    assert.throws(() => normaliseDomainName("  "), ValidationError);
  });

  it("rejects a name with no TLD", () => {
    assert.throws(() => normaliseDomainName("localhost"), ValidationError);
  });

  it("rejects a leading or trailing hyphen in a label", () => {
    assert.throws(() => normaliseDomainName("-bad.com"), ValidationError);
    assert.throws(() => normaliseDomainName("bad-.com"), ValidationError);
  });

  it("rejects characters outside letters, digits and hyphen", () => {
    assert.throws(() => normaliseDomainName("ex ample.com"), ValidationError);
    assert.throws(() => normaliseDomainName("exam_ple.com"), ValidationError);
  });

  it("rejects a label over 63 characters", () => {
    const label = "a".repeat(64);
    assert.throws(() => normaliseDomainName(`${label}.com`), ValidationError);
  });

  it("accepts a label of exactly 63 characters", () => {
    const label = "a".repeat(63);
    assert.equal(normaliseDomainName(`${label}.com`), `${label}.com`);
  });

  it("rejects a name over 253 characters", () => {
    // Six 60-character labels: every label is legal on its own, so this can
    // only be caught by the whole-name limit.
    const long = `${"a".repeat(60)}.`.repeat(6) + "com";
    assert.ok(long.length > 253, `長さ ${long.length}`);
    assert.throws(() => normaliseDomainName(long), ValidationError);
  });
});

describe("normalisePeriodYears", () => {
  it("defaults to one year", () => {
    assert.equal(normalisePeriodYears(undefined), 1);
  });

  it("accepts the documented bounds", () => {
    assert.equal(normalisePeriodYears(1), 1);
    assert.equal(normalisePeriodYears(10), 10);
  });

  it("rejects zero, negatives and anything past ten", () => {
    assert.throws(() => normalisePeriodYears(0), ValidationError);
    assert.throws(() => normalisePeriodYears(-1), ValidationError);
    assert.throws(() => normalisePeriodYears(11), ValidationError);
  });

  it("rejects a fractional period", () => {
    assert.throws(() => normalisePeriodYears(1.5), ValidationError);
  });
});

describe("normaliseContactName", () => {
  it("accepts every name on the registry allow-list", () => {
    for (const name of ALLOWED_CONTACT_NAMES) {
      assert.equal(normaliseContactName(name), name);
    }
  });

  it("falls back to a safe default when nothing was chosen", () => {
    assert.equal(normaliseContactName(undefined), "Taro Test");
    assert.equal(normaliseContactName(""), "Taro Test");
  });

  it("rejects a real-looking name, which the registry would 400", () => {
    assert.throws(() => normaliseContactName("田村 太郎"), ValidationError);
    assert.throws(() => normaliseContactName("John  Doe"), ValidationError);
  });
});

describe("buildContactEmail", () => {
  it("forces an allowed domain onto the local part", () => {
    assert.equal(buildContactEmail("taro", "u1"), "taro@example.com");
  });

  it("uses the fallback local part when none was entered", () => {
    assert.equal(buildContactEmail(undefined, "u000007"),
      "u000007@example.com");
  });

  it("rejects a local part with characters the registry forbids", () => {
    assert.throws(() => buildContactEmail("ta ro", "u1"), ValidationError);
    assert.throws(() => buildContactEmail("taro@evil.com", "u1"),
      ValidationError);
  });
});

describe("normaliseNameservers", () => {
  it("returns an empty list when none were given", () => {
    assert.deepEqual(normaliseNameservers(undefined), []);
    assert.deepEqual(normaliseNameservers([]), []);
  });

  it("lower-cases and de-duplicates", () => {
    assert.deepEqual(
      normaliseNameservers(["NS1.Example.com", "ns1.example.com."]),
      ["ns1.example.com"],
    );
  });

  it("rejects something that is not a hostname", () => {
    assert.throws(() => normaliseNameservers(["not a host"]),
      ValidationError);
    assert.throws(() => normaliseNameservers(["ns1"]), ValidationError);
  });
});

describe("validateAuthInfo", () => {
  it("accepts 1 to 64 characters", () => {
    assert.equal(validateAuthInfo("a"), "a");
    assert.equal(validateAuthInfo("x".repeat(64)), "x".repeat(64));
  });

  it("rejects empty and over-long passphrases", () => {
    assert.throws(() => validateAuthInfo(""), ValidationError);
    assert.throws(() => validateAuthInfo("x".repeat(65)), ValidationError);
  });
});
