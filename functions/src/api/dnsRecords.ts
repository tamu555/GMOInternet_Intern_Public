/**
 * Rental-DNS Callables (FIG.11, spec §6.3): `listDnsRecords`,
 * `saveDnsRecords`, `resolveDns`.
 *
 * These replace the functions-stubs implementations of the same names — the
 * stub codebase must not export them once these exist, because colliding
 * export names across codebases break the emulator load. No registry call is
 * ever made (§6.3.1: the registry has no record API), so none of these need
 * registry secrets or a raised timeout; the zone store in
 * `domain/dnsZones.ts` is the entire backend.
 *
 * Contract notes (must not drift — the frontend is already wired,
 * frontend/src/api/dnsApi.ts):
 * - `saveDnsRecords` is full-replacement: the whole record set replaces the
 *   zone, and the saved set is echoed back.
 * - `resolveDns` answers an EMPTY array for "nothing found" — never an
 *   error. The frontend folds empty into the「反映待ち」state (§6.3.3d).
 * - Absent `ttl`/`priority` serialise as `null`; the frontend strips them.
 * - `resolveDns` deliberately has no ownership check (a resolver answers
 *   about any name — DNS data is public by nature) but still requires
 *   authentication like every other Callable here.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {
  isDnsRecordType,
  normaliseDnsRecords,
  normaliseFqdn,
  readZoneRecords,
  replaceZoneRecords,
  resolveZoneRecords,
  type DnsRecord,
  type DnsRecordType,
} from "../domain/dnsZones";
import {assertOwnsDomain} from "../domain/ownership";
import {normaliseDomainName, ValidationError} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Response shared by all three Callables. */
export interface DnsRecordsResponse {
  records: DnsRecord[];
}

/** Dependencies the handlers need, substitutable in tests. */
export interface DnsRecordsDependencies {
  assertOwnsDomain(uid: string, domainName: string): Promise<unknown>;
  readZoneRecords(uid: string, domainName: string): Promise<DnsRecord[]>;
  replaceZoneRecords(
    uid: string,
    domainName: string,
    records: DnsRecord[],
  ): Promise<DnsRecord[]>;
  resolveZoneRecords(
    fqdn: string,
    type: DnsRecordType,
  ): Promise<DnsRecord[]>;
}

const defaultDependencies: DnsRecordsDependencies = {
  assertOwnsDomain: (uid, domainName) => assertOwnsDomain(uid, domainName),
  readZoneRecords: (uid, domainName) => readZoneRecords(uid, domainName),
  replaceZoneRecords: (uid, domainName, records) =>
    replaceZoneRecords(uid, domainName, records),
  resolveZoneRecords: (fqdn, type) => resolveZoneRecords(fqdn, type),
};

/**
 * @param {CallableRequest<unknown>} request Callable request.
 * @return {string} Authenticated caller uid.
 */
function requireUid(request: CallableRequest<unknown>): string {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  return request.auth.uid;
}

/**
 * @param {unknown} data Callable request data.
 * @return {string} Canonical domain name.
 */
function requireDomainName(data: unknown): string {
  const raw = (data as {domainName?: unknown} | null | undefined)?.domainName;
  if (typeof raw !== "string") {
    throw new ValidationError(
      "domainName",
      "ドメイン名は文字列で指定してください。",
    );
  }
  return normaliseDomainName(raw);
}

/**
 * Handles one `listDnsRecords` invocation: auth → input validation →
 * ownership (foreign/unknown domains are indistinguishable,
 * `permission-denied`) → zone read. A domain with no saved zone answers an
 * empty array, not an error.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {DnsRecordsDependencies} dependencies Injectable dependencies.
 * @return {Promise<DnsRecordsResponse>} The saved records.
 */
export async function handleListDnsRecords(
  request: CallableRequest<unknown>,
  dependencies: DnsRecordsDependencies = defaultDependencies,
): Promise<DnsRecordsResponse> {
  const uid = requireUid(request);
  try {
    const domainName = requireDomainName(request.data);
    await dependencies.assertOwnsDomain(uid, domainName);
    return {records: await dependencies.readZoneRecords(uid, domainName)};
  } catch (error) {
    throw toHttpsError(error, "listDnsRecords");
  }
}

/**
 * Handles one `saveDnsRecords` invocation: auth → input validation →
 * ownership → full-replacement write. Validation runs before the ownership
 * read so a malformed body never costs a Firestore round-trip.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {DnsRecordsDependencies} dependencies Injectable dependencies.
 * @return {Promise<DnsRecordsResponse>} The stored records, echoed back.
 */
export async function handleSaveDnsRecords(
  request: CallableRequest<unknown>,
  dependencies: DnsRecordsDependencies = defaultDependencies,
): Promise<DnsRecordsResponse> {
  const uid = requireUid(request);
  try {
    const data = (request.data ?? {}) as {records?: unknown};
    const domainName = requireDomainName(request.data);
    const records = normaliseDnsRecords(data.records);
    await dependencies.assertOwnsDomain(uid, domainName);
    return {
      records: await dependencies.replaceZoneRecords(
        uid,
        domainName,
        records,
      ),
    };
  } catch (error) {
    throw toHttpsError(error, "saveDnsRecords");
  }
}

/**
 * Handles one `resolveDns` invocation: auth → input validation → store
 * lookup. No ownership check (see module doc); "not found" is an empty
 * array, never an error.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {DnsRecordsDependencies} dependencies Injectable dependencies.
 * @return {Promise<DnsRecordsResponse>} Matching records; possibly empty.
 */
export async function handleResolveDns(
  request: CallableRequest<unknown>,
  dependencies: DnsRecordsDependencies = defaultDependencies,
): Promise<DnsRecordsResponse> {
  requireUid(request);
  try {
    const data = (request.data ?? {}) as {name?: unknown; type?: unknown};
    if (typeof data.name !== "string") {
      throw new ValidationError("name", "nameは文字列で指定してください。");
    }
    const fqdn = normaliseFqdn(data.name);
    if (!isDnsRecordType(data.type)) {
      throw new ValidationError(
        "type",
        "typeはA/AAAA/CNAME/MX/TXT/NSのいずれかで指定してください。",
      );
    }
    return {records: await dependencies.resolveZoneRecords(fqdn, data.type)};
  } catch (error) {
    throw toHttpsError(error, "resolveDns");
  }
}

/** Production `listDnsRecords` Callable. */
export const listDnsRecords = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleListDnsRecords(request);
});

/** Production `saveDnsRecords` Callable. */
export const saveDnsRecords = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleSaveDnsRecords(request);
});

/**
 * Production `resolveDns` Callable. `handleResolveDns` deliberately has no
 * ownership check (a resolver answers about any name), but it still calls
 * out to our zone store on the caller's behalf, so the same active-member
 * gate as every other Callable here applies.
 */
export const resolveDns = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleResolveDns(request);
});
