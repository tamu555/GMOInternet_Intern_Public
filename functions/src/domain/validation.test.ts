import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  normaliseCreateHostData,
  normaliseHostAddresses,
  normaliseTransferAction,
  normaliseTransferAuthInfo,
  normaliseUpdateContactData,
  normaliseUpdateDomainData,
  normaliseUpdateHostData,
  validateClientStatuses,
  validateContactRoleChanges,
  validateSecDns,
  ValidationError,
} from "./validation.js";

/**
 * Builds a minimal valid `updateDomain` payload, overridable per test.
 *
 * @param {object} overrides Fields to override on top of the base payload.
 * @return {object} A payload ready to pass to `normaliseUpdateDomainData`.
 */
function baseUpdateDomainInput(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "op-1",
    domainName: "example.com",
    add: {nameservers: ["ns1.example.com"]},
    ...overrides,
  };
}

describe("validateClientStatuses", () => {
  it("accepts every allow-listed client* status", () => {
    const statuses = validateClientStatuses([
      "clientHold",
      "clientTransferProhibited",
      "clientUpdateProhibited",
      "clientDeleteProhibited",
      "clientRenewProhibited",
    ]);
    assert.deepEqual(statuses, [
      "clientHold",
      "clientTransferProhibited",
      "clientUpdateProhibited",
      "clientDeleteProhibited",
      "clientRenewProhibited",
    ]);
  });

  it("returns an empty list when undefined", () => {
    assert.deepEqual(validateClientStatuses(undefined), []);
  });

  it("rejects every server* status", () => {
    const serverStatuses = [
      "serverHold",
      "serverTransferProhibited",
      "serverUpdateProhibited",
      "serverDeleteProhibited",
      "serverRenewProhibited",
    ];
    for (const status of serverStatuses) {
      assert.throws(
        () => validateClientStatuses([status]),
        ValidationError,
        status,
      );
    }
  });

  it("rejects case variants of allowed statuses", () => {
    assert.throws(
      () => validateClientStatuses(["clienthold"]),
      ValidationError,
    );
    assert.throws(
      () => validateClientStatuses(["CLIENTHOLD"]),
      ValidationError,
    );
    assert.throws(
      () => validateClientStatuses(["ClientHold"]),
      ValidationError,
    );
  });

  it("rejects unknown statuses and non-array input", () => {
    assert.throws(
      () => validateClientStatuses(["pendingCreate"]),
      ValidationError,
    );
    assert.throws(() => validateClientStatuses("clientHold"), ValidationError);
  });

  it("rejects duplicate statuses", () => {
    assert.throws(
      () => validateClientStatuses(["clientHold", "clientHold"]),
      ValidationError,
    );
  });
});

describe("validateContactRoleChanges", () => {
  it("accepts admin/tech/billing roles", () => {
    const result = validateContactRoleChanges([
      {role: "admin", contactId: "c-1"},
      {role: "tech", contactId: "c-2"},
      {role: "billing", contactId: "c-3"},
    ]);
    assert.equal(result.length, 3);
  });

  it("rejects the registrant role", () => {
    assert.throws(
      () =>
        validateContactRoleChanges([{role: "registrant", contactId: "c-1"}]),
      ValidationError,
    );
  });

  it("rejects unknown keys on an entry", () => {
    assert.throws(
      () =>
        validateContactRoleChanges([
          {role: "admin", contactId: "c-1", authInfo: "x"},
        ]),
      ValidationError,
    );
  });

  it("rejects duplicate role/contactId pairs", () => {
    assert.throws(
      () =>
        validateContactRoleChanges([
          {role: "admin", contactId: "c-1"},
          {role: "admin", contactId: "c-1"},
        ]),
      ValidationError,
    );
  });

  it("rejects a missing or empty contactId", () => {
    assert.throws(
      () => validateContactRoleChanges([{role: "admin", contactId: ""}]),
      ValidationError,
    );
    assert.throws(
      () => validateContactRoleChanges([{role: "admin"}]),
      ValidationError,
    );
  });
});

describe("validateSecDns", () => {
  const validDsData = {
    keyTag: 12345,
    algorithm: 8,
    digestType: 2,
    digest: "a".repeat(64),
  };

  it("accepts a replace action with valid dsData", () => {
    const result = validateSecDns({action: "replace", dsData: [validDsData]});
    assert.equal(result.action, "replace");
    assert.equal("dsData" in result && result.dsData.length, 1);
  });

  it("accepts a removeAll action with no dsData", () => {
    const result = validateSecDns({action: "removeAll"});
    assert.deepEqual(result, {action: "removeAll"});
  });

  it("rejects removeAll carrying dsData (mutual exclusion)", () => {
    assert.throws(
      () => validateSecDns({action: "removeAll", dsData: [validDsData]}),
      ValidationError,
    );
  });

  it("rejects replace with an empty dsData list", () => {
    assert.throws(
      () => validateSecDns({action: "replace", dsData: []}),
      ValidationError,
    );
  });

  it("rejects an unknown action", () => {
    assert.throws(
      () => validateSecDns({action: "remove"}),
      ValidationError,
    );
  });

  it("validates keyTag range (0..65535)", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, keyTag: -1}],
        }),
      ValidationError,
    );
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, keyTag: 65536}],
        }),
      ValidationError,
    );
    assert.doesNotThrow(() =>
      validateSecDns({
        action: "replace",
        dsData: [{...validDsData, keyTag: 0}],
      }),
    );
    assert.doesNotThrow(() =>
      validateSecDns({
        action: "replace",
        dsData: [{...validDsData, keyTag: 65535}],
      }),
    );
  });

  it("validates algorithm range (0..255)", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, algorithm: -1}],
        }),
      ValidationError,
    );
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, algorithm: 256}],
        }),
      ValidationError,
    );
  });

  it("rejects an unsupported digestType", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, digestType: 99, digest: "ab"}],
        }),
      ValidationError,
    );
  });

  it("rejects an odd-length digest", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, digest: "abc"}],
        }),
      ValidationError,
    );
  });

  it("rejects a non-hex digest", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, digest: "zz".repeat(32)}],
        }),
      ValidationError,
    );
  });

  it("rejects a digest whose length does not match digestType", () => {
    // digestType 1 (SHA-1) expects 40 hex chars, not 64.
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, digestType: 1, digest: "a".repeat(64)}],
        }),
      ValidationError,
    );
  });

  it("accepts every supported digestType at its exact expected length", () => {
    const lengths: Record<number, number> = {1: 40, 2: 64, 3: 64, 4: 96};
    for (const [digestType, length] of Object.entries(lengths)) {
      assert.doesNotThrow(() =>
        validateSecDns({
          action: "replace",
          dsData: [
            {
              ...validDsData,
              digestType: Number(digestType),
              digest: "a".repeat(length),
            },
          ],
        }),
      );
    }
  });

  it("rejects duplicate dsData records", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [validDsData, {...validDsData}],
        }),
      ValidationError,
    );
  });

  it("rejects unknown keys on a dsData entry", () => {
    assert.throws(
      () =>
        validateSecDns({
          action: "replace",
          dsData: [{...validDsData, extra: "x"}],
        }),
      ValidationError,
    );
  });
});

describe("normaliseHostAddresses", () => {
  it("tags IPv4 and IPv6 addresses explicitly", () => {
    const result = normaliseHostAddresses(["192.0.2.1", "2001:db8::1"]);
    assert.deepEqual(result, [
      {ip: "192.0.2.1", version: "v4"},
      {ip: "2001:db8::1", version: "v6"},
    ]);
  });

  it("rejects an invalid address", () => {
    assert.throws(
      () => normaliseHostAddresses(["not-an-ip"]),
      ValidationError,
    );
  });

  it("rejects duplicate addresses", () => {
    assert.throws(
      () => normaliseHostAddresses(["192.0.2.1", "192.0.2.1"]),
      ValidationError,
    );
  });

  it("rejects non-array input", () => {
    assert.throws(() => normaliseHostAddresses("192.0.2.1"), ValidationError);
  });
});

describe("normaliseUpdateDomainData", () => {
  it("accepts a minimal nameserver add", () => {
    const result = normaliseUpdateDomainData(baseUpdateDomainInput());
    assert.equal(result.domainName, "example.com");
    assert.deepEqual(result.add?.nameservers, ["ns1.example.com"]);
  });

  it("normalises the domain name", () => {
    const result = normaliseUpdateDomainData(
      baseUpdateDomainInput({domainName: "EXAMPLE.com."}),
    );
    assert.equal(result.domainName, "example.com");
  });

  it("accepts registrant and secDns changes", () => {
    const result = normaliseUpdateDomainData(
      baseUpdateDomainInput({
        add: undefined,
        change: {
          registrantContactId: "c-1",
          secDns: {action: "removeAll"},
        },
      }),
    );
    assert.equal(result.change?.registrantContactId, "c-1");
    assert.deepEqual(result.change?.secDns, {action: "removeAll"});
  });

  it("rejects a request with no operationId", () => {
    const input = baseUpdateDomainInput();
    delete (input as Record<string, unknown>)["operationId"];
    assert.throws(() => normaliseUpdateDomainData(input), ValidationError);
  });

  it("rejects an unknown top-level key", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({registry: "kitaqsign"}),
        ),
      ValidationError,
    );
  });

  it("rejects an unknown key nested inside add", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({
            add: {nameservers: ["ns1.example.com"], foo: 1},
          }),
        ),
      ValidationError,
    );
  });

  it("rejects a structural no-op (nothing in add/remove/change)", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({add: undefined}),
        ),
      ValidationError,
    );
  });

  it("rejects an empty add block", () => {
    assert.throws(
      () => normaliseUpdateDomainData(baseUpdateDomainInput({add: {}})),
      ValidationError,
    );
  });

  it("rejects an empty change block", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({add: undefined, change: {}}),
        ),
      ValidationError,
    );
  });

  it("rejects the same nameserver in both add and remove", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({
            add: {nameservers: ["ns1.example.com"]},
            remove: {nameservers: ["ns1.example.com"]},
          }),
        ),
      ValidationError,
    );
  });

  it("rejects the same status in both add and remove", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({
            add: {statuses: ["clientHold"]},
            remove: {statuses: ["clientHold"]},
          }),
        ),
      ValidationError,
    );
  });

  it("rejects the same contact role/id in both add and remove", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({
            add: {contacts: [{role: "admin", contactId: "c-1"}]},
            remove: {contacts: [{role: "admin", contactId: "c-1"}]},
          }),
        ),
      ValidationError,
    );
  });

  it("allows disjoint nameservers in add and remove", () => {
    const result = normaliseUpdateDomainData(
      baseUpdateDomainInput({
        add: {nameservers: ["ns1.example.com"]},
        remove: {nameservers: ["ns2.example.com"]},
      }),
    );
    assert.deepEqual(result.add?.nameservers, ["ns1.example.com"]);
    assert.deepEqual(result.remove?.nameservers, ["ns2.example.com"]);
  });

  it("rejects any server* status even mixed with valid client* ones", () => {
    assert.throws(
      () =>
        normaliseUpdateDomainData(
          baseUpdateDomainInput({
            add: {statuses: ["clientHold", "serverHold"]},
          }),
        ),
      ValidationError,
    );
  });

  describe("authInfo injection at every nesting level", () => {
    it("rejects top-level authInfo", () => {
      assert.throws(
        () => normaliseUpdateDomainData(baseUpdateDomainInput({authInfo: "x"})),
        ValidationError,
      );
    });

    it("rejects chg-level authInfo via change", () => {
      assert.throws(
        () =>
          normaliseUpdateDomainData(
            baseUpdateDomainInput({
              add: undefined,
              change: {registrantContactId: "c-1", authInfo: "x"},
            }),
          ),
        ValidationError,
      );
    });

    it("rejects authInfo nested inside add", () => {
      assert.throws(
        () =>
          normaliseUpdateDomainData(
            baseUpdateDomainInput({
              add: {nameservers: ["ns1.example.com"], authInfo: "x"},
            }),
          ),
        ValidationError,
      );
    });

    it("rejects authInfo nested inside an add.contacts entry", () => {
      assert.throws(
        () =>
          normaliseUpdateDomainData(
            baseUpdateDomainInput({
              add: {
                contacts: [{role: "admin", contactId: "c-1", authInfo: "x"}],
              },
            }),
          ),
        ValidationError,
      );
    });

    it("rejects authInfo nested inside change.secDns", () => {
      assert.throws(
        () =>
          normaliseUpdateDomainData(
            baseUpdateDomainInput({
              add: undefined,
              change: {
                secDns: {action: "removeAll", authInfo: "x"},
              },
            }),
          ),
        ValidationError,
      );
    });

    it("rejects a case-variant authInfo key", () => {
      assert.throws(
        () =>
          normaliseUpdateDomainData(baseUpdateDomainInput({AuthInfo: "x"})),
        ValidationError,
      );
    });
  });
});

describe("normaliseUpdateContactData", () => {
  /**
   * Builds a minimal valid `updateContact` payload, overridable per test.
   *
   * @param {Record<string, unknown>} overrides Fields to override.
   * @return {object} A payload ready to pass to `normaliseUpdateContactData`.
   */
  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      operationId: "op-1",
      contactId: "c-1",
      contextDomainName: "example.com",
      change: {voice: "+81.312345678"},
      ...overrides,
    };
  }

  it("accepts a voice-only change", () => {
    const result = normaliseUpdateContactData(baseInput());
    assert.equal(result.change.voice, "+81.312345678");
  });

  it("builds a full email address from emailLocalPart", () => {
    const result = normaliseUpdateContactData(
      baseInput({change: {emailLocalPart: "member"}}),
    );
    assert.equal(result.change.email, "member@example.com");
  });

  it("rejects a change block with no fields set (no-op)", () => {
    assert.throws(
      () => normaliseUpdateContactData(baseInput({change: {}})),
      ValidationError,
    );
  });

  it("rejects an unknown key in change", () => {
    assert.throws(
      () =>
        normaliseUpdateContactData(
          baseInput({
            change: {voice: "+81.312345678", fax: undefined, extra: 1},
          }),
        ),
      ValidationError,
    );
  });

  it("rejects authInfo nested inside change", () => {
    assert.throws(
      () =>
        normaliseUpdateContactData(
          baseInput({change: {voice: "+81.312345678", authInfo: "x"}}),
        ),
      ValidationError,
    );
  });

  it("rejects an invalid voice format", () => {
    assert.throws(
      () =>
        normaliseUpdateContactData(
          baseInput({change: {voice: "0312345678"}}),
        ),
      ValidationError,
    );
  });
});

describe("normaliseCreateHostData", () => {
  /**
   * Builds a minimal valid `createHost` payload, overridable per test.
   *
   * @param {Record<string, unknown>} overrides Fields to override.
   * @return {object} A payload ready to pass to `normaliseCreateHostData`.
   */
  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      operationId: "op-1",
      parentDomainName: "example.com",
      hostName: "ns1.example.com",
      addresses: ["192.0.2.1"],
      ...overrides,
    };
  }

  it("accepts a strict subdomain host with an address", () => {
    const result = normaliseCreateHostData(baseInput());
    assert.equal(result.hostName, "ns1.example.com");
    assert.equal(result.addresses.length, 1);
  });

  it("rejects a hostName equal to the parent domain", () => {
    assert.throws(
      () =>
        normaliseCreateHostData(
          baseInput({hostName: "example.com"}),
        ),
      ValidationError,
    );
  });

  it("rejects a hostName that is not a subdomain of the parent", () => {
    assert.throws(
      () =>
        normaliseCreateHostData(
          baseInput({hostName: "ns1.other.com"}),
        ),
      ValidationError,
    );
  });

  it("rejects a request with no addresses", () => {
    assert.throws(
      () => normaliseCreateHostData(baseInput({addresses: []})),
      ValidationError,
    );
  });

  it("rejects authInfo nested inside the request", () => {
    assert.throws(
      () => normaliseCreateHostData(baseInput({authInfo: "x"})),
      ValidationError,
    );
  });
});

describe("normaliseUpdateHostData", () => {
  /**
   * Builds a minimal valid `updateHost` payload, overridable per test.
   *
   * @param {Record<string, unknown>} overrides Fields to override.
   * @return {object} A payload ready to pass to `normaliseUpdateHostData`.
   */
  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      operationId: "op-1",
      hostName: "ns1.example.com",
      add: {addresses: ["192.0.2.1"]},
      ...overrides,
    };
  }

  it("accepts an address add", () => {
    const result = normaliseUpdateHostData(baseInput());
    assert.deepEqual(result.add?.addresses, [{ip: "192.0.2.1", version: "v4"}]);
  });

  it("rejects a request with neither add nor remove", () => {
    assert.throws(
      () => normaliseUpdateHostData(baseInput({add: undefined})),
      ValidationError,
    );
  });

  it("rejects the same address in both add and remove", () => {
    assert.throws(
      () =>
        normaliseUpdateHostData(
          baseInput({
            add: {addresses: ["192.0.2.1"]},
            remove: {addresses: ["192.0.2.1"]},
          }),
        ),
      ValidationError,
    );
  });

  it("allows disjoint addresses in add and remove", () => {
    const result = normaliseUpdateHostData(
      baseInput({
        add: {addresses: ["192.0.2.1"]},
        remove: {addresses: ["192.0.2.2"]},
      }),
    );
    assert.deepEqual(result.add?.addresses, [{ip: "192.0.2.1", version: "v4"}]);
    assert.deepEqual(result.remove?.addresses, [
      {ip: "192.0.2.2", version: "v4"},
    ]);
  });

  it("rejects authInfo nested inside add", () => {
    assert.throws(
      () =>
        normaliseUpdateHostData(
          baseInput({add: {addresses: ["192.0.2.1"], authInfo: "x"}}),
        ),
      ValidationError,
    );
  });

  it("rejects hostName rename fields (not modeled)", () => {
    assert.throws(
      () =>
        normaliseUpdateHostData(
          baseInput({newHostName: "ns2.example.com"}),
        ),
      ValidationError,
    );
  });
});

// --- transfer input (spec 6.6.2) ------------------------------------------

describe("normaliseTransferAuthInfo", () => {
  it("trims the pasted AuthCode", () => {
    assert.equal(normaliseTransferAuthInfo("  s3cr3t-pass \n"), "s3cr3t-pass");
  });

  it("accepts exactly 64 characters, the registry's limit", () => {
    const limit = "a".repeat(64);
    assert.equal(normaliseTransferAuthInfo(limit), limit);
  });

  it("rejects 65 characters", () => {
    assert.throws(
      () => normaliseTransferAuthInfo("a".repeat(65)),
      ValidationError,
    );
  });

  it("rejects an empty or whitespace-only value", () => {
    assert.throws(() => normaliseTransferAuthInfo(""), ValidationError);
    assert.throws(() => normaliseTransferAuthInfo("   "), ValidationError);
  });

  it("rejects a non-string rather than coercing it", () => {
    // String(undefined) would put the literal "undefined" on the wire.
    assert.throws(() => normaliseTransferAuthInfo(undefined), ValidationError);
    assert.throws(() => normaliseTransferAuthInfo(12345), ValidationError);
    assert.throws(() => normaliseTransferAuthInfo(null), ValidationError);
  });

  it("names the offending field so the form can highlight it", () => {
    try {
      normaliseTransferAuthInfo("");
      assert.fail("expected a ValidationError");
    } catch (error) {
      assert.equal((error as ValidationError).field, "authInfo");
    }
  });
});

describe("normaliseTransferAction", () => {
  it("accepts the two documented answers", () => {
    assert.equal(normaliseTransferAction("approve"), "approve");
    assert.equal(normaliseTransferAction("reject"), "reject");
  });

  it("rejects anything else, including the gaining-side operations", () => {
    for (const bad of ["cancel", "request", "APPROVE", "", undefined, 1]) {
      assert.throws(() => normaliseTransferAction(bad), ValidationError);
    }
  });
});
