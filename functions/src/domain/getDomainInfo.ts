/**
 * Live-detail orchestration for the EPP Info feature (FIG.10).
 *
 * `getOwnedDomain()` runs first and unconditionally: on `null` this function
 * returns immediately, before a registry client is constructed or
 * `infoDomain()` is called. That ordering is the security boundary for the
 * detail flow — everything past it can assume the caller already owns the
 * domain, and it is exercised as an explicit test (0 calls to
 * `getRegistryClient` / `infoDomain` on denial).
 */
import type {RegistryClient} from "../bridge/registryClient";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryId} from "../config/options";
import {adhocClTrid} from "./clTrid";
import {getOwnedDomain, type OwnedDomain} from "./domainRepository";

/** Explicit, hand-built response DTO. Never a spread of `DomainInfo`. */
export interface GetDomainInfoResponse {
  domain: string;
  registry: RegistryId;
  status: string[];
  registrant: string;
  contacts: Record<string, string>;
  nameservers: string[];
  crDate: string;
  upDate: string | null;
  exDate: string | null;
  trDate: string | null;
  rgpStatus: string[];
}

/** Dependencies `getLiveDomainInfo` needs, substitutable for unit tests. */
export interface GetLiveDomainInfoDependencies {
  getOwnedDomain(
    uid: string,
    normalizedName: string,
  ): Promise<OwnedDomain | null>;

  getRegistryClient(
    registry: RegistryId,
  ): Pick<RegistryClient, "infoDomain">;

  createClTrid(uid: string): string;
}

const PRODUCTION_DEPENDENCIES: GetLiveDomainInfoDependencies = {
  getOwnedDomain,
  getRegistryClient,
  createClTrid: (uid) => adhocClTrid("INFO", uid.slice(0, 12)),
};

/**
 * Runs the ownership-gated live `domain:info` lookup for one domain.
 *
 * @param {string} uid Authenticated caller.
 * @param {string} normalizedName Domain name, already normalised.
 * @param {GetLiveDomainInfoDependencies} dependencies Overridable
 *   collaborators; defaults to the production repository and registry
 *   client.
 * @return {Promise<GetDomainInfoResponse | null>} `null` when the caller
 *   does not own the domain (or it does not exist) — identical for both
 *   cases, so the API layer can answer with a uniform not-found.
 */
export async function getLiveDomainInfo(
  uid: string,
  normalizedName: string,
  dependencies: GetLiveDomainInfoDependencies = PRODUCTION_DEPENDENCIES,
): Promise<GetDomainInfoResponse | null> {
  const owned = await dependencies.getOwnedDomain(uid, normalizedName);
  if (!owned) return null;

  const client = dependencies.getRegistryClient(owned.registry);
  const clTRID = dependencies.createClTrid(uid);
  const info = await client.infoDomain(normalizedName, clTRID, {uid});

  return {
    domain: info.domain,
    registry: info.registry,
    status: info.status,
    registrant: info.registrant,
    contacts: info.contacts,
    nameservers: info.nameservers,
    crDate: info.crDate,
    upDate: info.upDate ?? null,
    exDate: info.exDate ?? null,
    trDate: info.trDate ?? null,
    rgpStatus: info.rgpStatus,
  };
}
