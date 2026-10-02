import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {RegistryError} from "../bridge/errors";
import type {DomainInfo} from "../bridge/types";
import type {CommandContext, RegistryClient} from "../bridge/registryClient";
import type {RegistryId} from "../config/options";
import {
  getLiveDomainInfo,
  type GetLiveDomainInfoDependencies,
} from "./getDomainInfo";
import type {OwnedDomain} from "./domainRepository";

const UID = "member-uid";
const NORMALIZED_NAME = "example.com";
const OWNED: OwnedDomain = {name: NORMALIZED_NAME, registry: "kitaqsign"};

/** Minimal `domain:info` answer with every optional field populated. */
const FULL_DOMAIN_INFO: DomainInfo = {
  domain: NORMALIZED_NAME,
  registry: "kitaqsign",
  status: ["ok"],
  registrant: "contact-1",
  contacts: {ADMIN: "contact-1", TECH: "contact-1"},
  nameservers: ["ns1.example.com"],
  crDate: "2026-01-01T00:00:00Z",
  upDate: "2026-02-01T00:00:00Z",
  exDate: "2027-01-01T00:00:00Z",
  trDate: "2026-03-01T00:00:00Z",
  rgpStatus: ["addPeriod"],
};

/** One recorded call to the spied `infoDomain` method. */
interface InfoDomainCall {
  name: string;
  clTRID: string;
  context: CommandContext | undefined;
}

/** Call-tracking spy around a fixed `infoDomain` response or error. */
interface InfoDomainSpy {
  calls: InfoDomainCall[];
  infoDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainInfo>;
}

/**
 * Builds a spy that records every `infoDomain` call and resolves/rejects
 * with a fixed outcome.
 *
 * @param {DomainInfo | Error} outcome Value to resolve, or error to reject.
 * @return {InfoDomainSpy} Spy exposing its recorded calls.
 */
function buildInfoDomainSpy(outcome: DomainInfo | Error): InfoDomainSpy {
  const calls: InfoDomainCall[] = [];
  return {
    calls,
    infoDomain: (name, clTRID, context) => {
      calls.push({name, clTRID, context});
      return outcome instanceof Error ?
        Promise.reject(outcome) :
        Promise.resolve(outcome);
    },
  };
}

/** Dependency bundle plus the spies used to assert on their call sites. */
interface DependencyFixture {
  dependencies: GetLiveDomainInfoDependencies;
  infoDomainSpy: InfoDomainSpy;
  getRegistryClientCalls: RegistryId[];
}

/**
 * Builds a dependency bundle wired to spies, so each assertion can inspect
 * exactly which collaborators were invoked and with what arguments.
 *
 * @param {object} options Fixture configuration.
 * @return {DependencyFixture} Dependencies plus their spies.
 */
function buildDependencies(options: {
  owned: OwnedDomain | null;
  outcome?: DomainInfo | Error;
}): DependencyFixture {
  const infoDomainSpy = buildInfoDomainSpy(options.outcome ?? FULL_DOMAIN_INFO);
  const getRegistryClientCalls: RegistryId[] = [];

  const dependencies: GetLiveDomainInfoDependencies = {
    getOwnedDomain: () => Promise.resolve(options.owned),
    getRegistryClient: (registry): Pick<RegistryClient, "infoDomain"> => {
      getRegistryClientCalls.push(registry);
      return infoDomainSpy;
    },
    createClTrid: () => "APP-INFO-MEMBER-UID",
  };

  return {dependencies, infoDomainSpy, getRegistryClientCalls};
}

describe("getLiveDomainInfo", () => {
  it(
    "calls infoDomain exactly once with the normalized name, INFO clTRID, " +
    "and {uid} context, using the mirror's verified registry",
    async () => {
      const {dependencies, infoDomainSpy, getRegistryClientCalls} =
        buildDependencies({owned: OWNED});

      await getLiveDomainInfo(UID, NORMALIZED_NAME, dependencies);

      assert.equal(infoDomainSpy.calls.length, 1);
      assert.deepEqual(infoDomainSpy.calls[0], {
        name: NORMALIZED_NAME,
        clTRID: "APP-INFO-MEMBER-UID",
        context: {uid: UID},
      });
      assert.deepEqual(getRegistryClientCalls, [OWNED.registry]);
    },
  );

  it("normalizes optional date fields to null when absent", async () => {
    const minimalInfo: DomainInfo = {
      domain: NORMALIZED_NAME,
      registry: "kitaqsign",
      status: [],
      registrant: "contact-1",
      contacts: {},
      nameservers: [],
      crDate: "2026-01-01T00:00:00Z",
      rgpStatus: [],
    };
    const {dependencies} = buildDependencies({
      owned: OWNED,
      outcome: minimalInfo,
    });

    const result = await getLiveDomainInfo(UID, NORMALIZED_NAME, dependencies);

    assert.deepEqual(result, {
      domain: NORMALIZED_NAME,
      registry: "kitaqsign",
      status: [],
      registrant: "contact-1",
      contacts: {},
      nameservers: [],
      crDate: "2026-01-01T00:00:00Z",
      upDate: null,
      exDate: null,
      trDate: null,
      rgpStatus: [],
    });
  });

  it("returns only the explicit DTO fields, never authInfo or unknowns",
    async () => {
      const infoWithExtraFields = {
        ...FULL_DOMAIN_INFO,
        authInfo: "leak-me-not",
        extensions: {secret: true},
      } as DomainInfo;
      const {dependencies} = buildDependencies({
        owned: OWNED,
        outcome: infoWithExtraFields,
      });

      const result = await getLiveDomainInfo(
        UID,
        NORMALIZED_NAME,
        dependencies,
      );

      assert.deepEqual(
        Object.keys(result ?? {}).sort(),
        [
          "contacts",
          "crDate",
          "domain",
          "exDate",
          "nameservers",
          "registrant",
          "registry",
          "rgpStatus",
          "status",
          "trDate",
          "upDate",
        ],
      );
    });

  it("propagates RegistryError.objectNotFound unchanged", async () => {
    const notFound = new RegistryError({
      kind: "objectNotFound",
      registry: "kitaqsign",
      command: "domain:info",
      message: "not found",
      clTRID: "APP-INFO-MEMBER-UID",
    });
    const {dependencies} = buildDependencies({
      owned: OWNED,
      outcome: notFound,
    });

    await assert.rejects(
      () => getLiveDomainInfo(UID, NORMALIZED_NAME, dependencies),
      (error: unknown) => error === notFound,
    );
  });

  it("propagates RegistryError.transport unchanged", async () => {
    const transportFailure = new RegistryError({
      kind: "transport",
      registry: "kitaqsign",
      command: "domain:info",
      message: "timeout",
      clTRID: "APP-INFO-MEMBER-UID",
      retryable: true,
    });
    const {dependencies} = buildDependencies({
      owned: OWNED,
      outcome: transportFailure,
    });

    await assert.rejects(
      () => getLiveDomainInfo(UID, NORMALIZED_NAME, dependencies),
      (error: unknown) => error === transportFailure,
    );
  });

  it(
    "never constructs a registry client or calls infoDomain when the " +
    "caller does not own the domain (mandatory security case)",
    async () => {
      const {dependencies, infoDomainSpy, getRegistryClientCalls} =
        buildDependencies({owned: null});

      const result = await getLiveDomainInfo(
        UID,
        NORMALIZED_NAME,
        dependencies,
      );

      assert.equal(result, null);
      assert.equal(getRegistryClientCalls.length, 0);
      assert.equal(infoDomainSpy.calls.length, 0);
    },
  );
});
