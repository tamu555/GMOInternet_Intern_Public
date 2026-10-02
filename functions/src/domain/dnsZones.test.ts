/**
 * Unit tests for the pure parts of the rental-DNS zone store: record
 * validation, FQDN normalisation, and the resolver's zone-candidate and
 * matching logic. The Firestore-backed functions are covered through the
 * Callable contract tests with substituted dependencies.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  normaliseDnsRecords,
  normaliseFqdn,
  recordsMatching,
  zoneCandidatesFor,
  MAX_RECORDS_PER_ZONE,
  type DnsRecord,
} from "./dnsZones";
import {ValidationError} from "./validation";

/**
 * Asserts an action throws a ValidationError on the given field.
 *
 * @param {Function} action Throwing action.
 * @param {string} field Expected offending field.
 */
function assertValidationError(action: () => unknown, field: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ValidationError, "expected a ValidationError");
    assert.equal((error as ValidationError).field, field);
    return true;
  });
}

describe("normaliseDnsRecords", () => {
  it("accepts a full record and normalises the name", () => {
    const records = normaliseDnsRecords([
      {type: "MX", name: "Mail.", value: "10 mx.example.net", ttl: 300,
        priority: 10},
    ]);
    assert.deepEqual(records, [
      {type: "MX", name: "mail", value: "10 mx.example.net", ttl: 300,
        priority: 10},
    ]);
  });

  it("treats missing/empty name as the apex and absent numbers as null", () => {
    const records = normaliseDnsRecords([
      {type: "A", name: "", value: "203.0.113.1"},
      {type: "TXT", name: "@", value: "v=spf1 -all"},
    ]);
    assert.deepEqual(records, [
      {type: "A", name: "@", value: "203.0.113.1", ttl: null, priority: null},
      {type: "TXT", name: "@", value: "v=spf1 -all", ttl: null,
        priority: null},
    ]);
  });

  it("accepts underscore labels (DKIM/DMARC style names)", () => {
    const records = normaliseDnsRecords([
      {type: "TXT", name: "selector._domainkey", value: "v=DKIM1; p=abc"},
    ]);
    assert.equal(records[0].name, "selector._domainkey");
  });

  it("rejects a non-array body", () => {
    assertValidationError(() => normaliseDnsRecords("nope"), "records");
  });

  it("rejects more records than the storage backstop", () => {
    const tooMany = Array.from({length: MAX_RECORDS_PER_ZONE + 1}, () => ({
      type: "A", name: "www", value: "203.0.113.1",
    }));
    assertValidationError(() => normaliseDnsRecords(tooMany), "records");
  });

  it("rejects an unknown key", () => {
    assertValidationError(
      () => normaliseDnsRecords([
        {type: "A", name: "www", value: "203.0.113.1", evil: true},
      ]),
      "records[0]",
    );
  });

  it("rejects an unknown type", () => {
    assertValidationError(
      () => normaliseDnsRecords([{type: "SRV", name: "www", value: "x"}]),
      "records[0].type",
    );
  });

  it("rejects an empty value", () => {
    assertValidationError(
      () => normaliseDnsRecords([{type: "A", name: "www", value: "  "}]),
      "records[0].value",
    );
  });

  it("rejects a name containing whitespace", () => {
    assertValidationError(
      () => normaliseDnsRecords([
        {type: "A", name: "w ww", value: "203.0.113.1"},
      ]),
      "records[0].name",
    );
  });

  it("rejects a non-integer ttl and an out-of-range priority", () => {
    assertValidationError(
      () => normaliseDnsRecords([
        {type: "A", name: "www", value: "203.0.113.1", ttl: 1.5},
      ]),
      "records[0].ttl",
    );
    assertValidationError(
      () => normaliseDnsRecords([
        {type: "MX", name: "@", value: "mx.example.net", priority: 65536},
      ]),
      "records[0].priority",
    );
  });
});

describe("normaliseFqdn", () => {
  it("lower-cases, trims, and strips the trailing dot", () => {
    assert.equal(normaliseFqdn(" WWW.Example.COM. "), "www.example.com");
  });

  it("accepts underscore labels", () => {
    assert.equal(normaliseFqdn("_dmarc.example.com"), "_dmarc.example.com");
  });

  it("rejects an empty or single-label name", () => {
    assertValidationError(() => normaliseFqdn(""), "name");
    assertValidationError(() => normaliseFqdn("localhost"), "name");
  });

  it("rejects whitespace inside the name", () => {
    assertValidationError(() => normaliseFqdn("www. example.com"), "name");
  });
});

describe("zoneCandidatesFor", () => {
  it("walks suffixes most specific first, never below two labels", () => {
    assert.deepEqual(zoneCandidatesFor("www.example.com"), [
      {zoneName: "www.example.com", relativeName: "@"},
      {zoneName: "example.com", relativeName: "www"},
    ]);
  });

  it("answers the apex for a bare domain", () => {
    assert.deepEqual(zoneCandidatesFor("example.com"), [
      {zoneName: "example.com", relativeName: "@"},
    ]);
  });

  it("keeps multi-label relative names intact", () => {
    const candidates = zoneCandidatesFor("a.b.example.com");
    assert.deepEqual(candidates[2], {
      zoneName: "example.com",
      relativeName: "a.b",
    });
  });
});

describe("recordsMatching", () => {
  const zone: DnsRecord[] = [
    {type: "A", name: "@", value: "203.0.113.1", ttl: null, priority: null},
    {type: "A", name: "www", value: "203.0.113.2", ttl: null, priority: null},
    {type: "TXT", name: "www", value: "hello", ttl: null, priority: null},
  ];

  it("filters by relative name and type", () => {
    assert.deepEqual(recordsMatching(zone, "www", "A"), [zone[1]]);
    assert.deepEqual(recordsMatching(zone, "@", "A"), [zone[0]]);
  });

  it("answers empty for a miss instead of throwing", () => {
    assert.deepEqual(recordsMatching(zone, "mail", "A"), []);
    assert.deepEqual(recordsMatching(zone, "www", "CNAME"), []);
  });

  it("treats a legacy empty name as the apex", () => {
    const legacy: DnsRecord[] = [
      {type: "A", name: "", value: "203.0.113.9", ttl: null, priority: null},
    ];
    assert.deepEqual(recordsMatching(legacy, "@", "A"), legacy);
  });
});
