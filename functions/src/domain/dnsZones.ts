/**
 * Rental-DNS zone store (spec §6.3, FIG.11).
 *
 * The registry holds nothing below `nameservers` (§6.3.1): content records
 * (A/AAAA/CNAME/MX/TXT/NS) live entirely in this app, one Firestore document
 * per zone in `dnsZones/{domainName}`. Saves are full-replacement — the
 * callable contract sends the whole record set, never a delta — so the zone
 * document is rewritten wholesale on every save.
 *
 * The document id is the bare domain name, deliberately NOT the
 * `{uid}__{name}` convention of the mirror collections: `resolveDns` is a
 * mini resolver (§6.3.2 Lv2) that walks a FQDN's suffixes to find the zone
 * without knowing any owner, the way public DNS answers about any name.
 * Ownership of list/save is enforced at the API layer via `assertOwnsDomain`;
 * the `uid` stored here additionally shadows a zone left behind by a previous
 * owner (e.g. after a transfer): it reads as empty for the new owner until
 * they save their own records.
 *
 * Records are NOT published to the real DNS: `resolveDns` answers from this
 * store only (implementation level 2 of §6.3.2 — no UDP 53 authority), so
 * `8.8.8.8` will never see them. The UI wording owns that explanation.
 */
import {FieldValue, type Firestore} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import {ValidationError} from "./validation";

/** Record types the rental DNS accepts (FIG.11 shared contract). */
export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
] as const;

/** One of {@link DNS_RECORD_TYPES}. */
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/**
 * Storage/wire shape of one record. Absent `ttl`/`priority` are held as
 * `null` (Firestore cannot store `undefined`), and returned as `null` — the
 * frontend strips nulls on receipt (frontend/src/api/dnsApi.ts), so the
 * response needs no reshaping here.
 */
export interface DnsRecord {
  type: DnsRecordType;
  /** Relative name: `"@"` for the zone apex, or labels like `"www"`. */
  name: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

/** Where a FQDN could live: a zone document and the name inside it. */
export interface ZoneCandidate {
  /** Candidate `dnsZones` document id (a registered domain name). */
  zoneName: string;
  /** Relative name inside that zone (`"@"` for the apex). */
  relativeName: string;
}

/** Storage backstop only — the real editing limits live in the frontend. */
export const MAX_RECORDS_PER_ZONE = 100;
const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_VALUE_LENGTH = 4096;
const MAX_TTL = 2147483647;
const MAX_PRIORITY = 65535;

const RECORD_KEYS = new Set(["type", "name", "value", "ttl", "priority"]);

/**
 * @param {unknown} value Candidate record type.
 * @return {boolean} Whether the value is a known record type.
 */
export function isDnsRecordType(value: unknown): value is DnsRecordType {
  return (DNS_RECORD_TYPES as readonly unknown[]).includes(value);
}

/**
 * Validates dotted-name label lengths shared by relative names and FQDNs.
 * Deliberately does NOT reuse `normaliseDomainName`'s charset rule: DNS
 * content names legitimately start with an underscore (`_dmarc`,
 * `selector._domainkey`) or a wildcard, which a registerable domain never
 * does.
 *
 * @param {string} name Lower-cased dotted name, no trailing dot.
 * @param {string} field Field label for the error.
 */
function assertLabelsWellFormed(name: string, field: string): void {
  if (/\s/.test(name)) {
    throw new ValidationError(field, "名前に空白は使えません。");
  }
  for (const label of name.split(".")) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw new ValidationError(
        field,
        "各ラベルは1〜63文字である必要があります。",
      );
    }
  }
}

/**
 * Normalises one record's relative name. `""` and `"@"` both mean the apex,
 * mirroring the stub the frontend was wired against.
 *
 * @param {unknown} raw Name as the client sent it.
 * @param {string} field Field label for the error.
 * @return {string} `"@"` or a lower-cased relative name.
 */
function normaliseRelativeName(raw: unknown, field: string): string {
  if (raw === undefined || raw === null) return "@";
  if (typeof raw !== "string") {
    throw new ValidationError(field, "名前は文字列で指定してください。");
  }
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (name === "" || name === "@") return "@";
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError(field, "名前は253文字以内である必要があります。");
  }
  assertLabelsWellFormed(name, field);
  return name;
}

/**
 * @param {unknown} raw Optional non-negative integer field.
 * @param {string} field Field label for the error.
 * @param {number} max Inclusive upper bound.
 * @param {string} label Human name of the field for the message.
 * @return {number | null} The integer, or `null` when absent.
 */
function normaliseOptionalInteger(
  raw: unknown,
  field: string,
  max: number,
  label: string,
): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ValidationError(field, `${label}は整数で指定してください。`);
  }
  if (raw < 0 || raw > max) {
    throw new ValidationError(
      field,
      `${label}は0〜${max}の範囲で指定してください。`,
    );
  }
  return raw;
}

/**
 * Parses and validates a `saveDnsRecords` record array. This is a structural
 * backstop only: the content-level rules (root-CNAME, MX priority, SPF
 * splitting, …) are frontend-owned per FIG.11 — the backend's job is safe
 * persistence.
 *
 * @param {unknown} raw `records` as the client sent it.
 * @return {DnsRecord[]} Validated records in storage shape.
 */
export function normaliseDnsRecords(raw: unknown): DnsRecord[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError("records", "recordsは配列で指定してください。");
  }
  if (raw.length > MAX_RECORDS_PER_ZONE) {
    throw new ValidationError(
      "records",
      `レコードは最大${MAX_RECORDS_PER_ZONE}件までです。`,
    );
  }
  return raw.map((entry, index) => {
    const field = `records[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ValidationError(
        field,
        "レコードはオブジェクトで指定してください。",
      );
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!RECORD_KEYS.has(key)) {
        throw new ValidationError(field, `不明なフィールドです: ${key}`);
      }
    }
    if (!isDnsRecordType(record.type)) {
      throw new ValidationError(
        `${field}.type`,
        "typeはA/AAAA/CNAME/MX/TXT/NSのいずれかで指定してください。",
      );
    }
    const name = normaliseRelativeName(record.name, `${field}.name`);
    if (typeof record.value !== "string" || record.value.trim() === "") {
      throw new ValidationError(`${field}.value`, "値を入力してください。");
    }
    const value = record.value.trim();
    if (value.length > MAX_VALUE_LENGTH) {
      throw new ValidationError(
        `${field}.value`,
        `値は${MAX_VALUE_LENGTH}文字以内である必要があります。`,
      );
    }
    return {
      type: record.type,
      name,
      value,
      ttl: normaliseOptionalInteger(record.ttl, `${field}.ttl`, MAX_TTL, "TTL"),
      priority: normaliseOptionalInteger(
        record.priority,
        `${field}.priority`,
        MAX_PRIORITY,
        "優先度",
      ),
    };
  });
}

/**
 * Normalises a `resolveDns` query name. Lenient on charset for the same
 * underscore/wildcard reason as record names, but must look like a FQDN.
 *
 * @param {string} raw Name as the client sent it.
 * @return {string} Lower-cased FQDN without a trailing dot.
 */
export function normaliseFqdn(raw: string): string {
  const name = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!name) {
    throw new ValidationError("name", "確認する名前が空です。");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ValidationError("name", "名前は253文字以内である必要があります。");
  }
  if (!name.includes(".")) {
    throw new ValidationError(
      "name",
      "FQDN形式（例: www.example.com）で指定してください。",
    );
  }
  assertLabelsWellFormed(name, "name");
  return name;
}

/**
 * Lists the zones a FQDN could belong to, most specific first. A zone id is
 * a registered domain, so a candidate needs at least two labels:
 * `www.example.com` yields `www.example.com` (relative `@`) then
 * `example.com` (relative `www`), never `com`.
 *
 * @param {string} fqdn Normalised FQDN (see {@link normaliseFqdn}).
 * @return {ZoneCandidate[]} Candidates in lookup order.
 */
export function zoneCandidatesFor(fqdn: string): ZoneCandidate[] {
  const labels = fqdn.split(".");
  const candidates: ZoneCandidate[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    candidates.push({
      zoneName: labels.slice(i).join("."),
      relativeName: i === 0 ? "@" : labels.slice(0, i).join("."),
    });
  }
  return candidates;
}

/**
 * Filters a zone's records down to one relative name and type, the way the
 * resolver answers a query. Stored names are already normalised, but the
 * comparison stays case-insensitive and treats `""` as the apex defensively.
 *
 * @param {DnsRecord[]} records All records of the zone.
 * @param {string} relativeName Relative name to answer for (`"@"` = apex).
 * @param {DnsRecordType} type Record type to answer for.
 * @return {DnsRecord[]} Matching records; empty when none match.
 */
export function recordsMatching(
  records: DnsRecord[],
  relativeName: string,
  type: DnsRecordType,
): DnsRecord[] {
  return records.filter((record) => {
    if (record.type !== type) return false;
    const stored = record.name === "" ? "@" : record.name.toLowerCase();
    return stored === relativeName;
  });
}

/**
 * Coerces whatever a zone document holds back into `DnsRecord[]`, dropping
 * anything that does not look like a record we wrote.
 *
 * @param {unknown} value Raw `records` field from Firestore.
 * @return {DnsRecord[]} The recognisable records.
 */
function sanitiseStoredRecords(value: unknown): DnsRecord[] {
  if (!Array.isArray(value)) return [];
  const records: DnsRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    if (!isDnsRecordType(record.type)) continue;
    if (typeof record.name !== "string") continue;
    if (typeof record.value !== "string") continue;
    records.push({
      type: record.type,
      name: record.name,
      value: record.value,
      ttl: typeof record.ttl === "number" ? record.ttl : null,
      priority: typeof record.priority === "number" ? record.priority : null,
    });
  }
  return records;
}

/**
 * Reads the caller's zone. A zone document whose `uid` is not the caller's
 * (left behind by a previous owner of a transferred domain) reads as empty —
 * the caller's first save then takes the zone over.
 *
 * @param {string} uid Caller uid, already ownership-checked by the API layer.
 * @param {string} domainName Canonical domain name.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<DnsRecord[]>} Saved records; empty when none.
 */
export async function readZoneRecords(
  uid: string,
  domainName: string,
  firestore: Firestore = db(),
): Promise<DnsRecord[]> {
  const snapshot = await firestore
    .collection(COLLECTIONS.dnsZones)
    .doc(domainName)
    .get();
  const data = snapshot.data();
  if (!data || data.uid !== uid) return [];
  return sanitiseStoredRecords(data.records);
}

/**
 * Replaces the zone wholesale (the contract's full-replacement semantics).
 *
 * @param {string} uid Caller uid, already ownership-checked by the API layer.
 * @param {string} domainName Canonical domain name.
 * @param {DnsRecord[]} records Validated records to store.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<DnsRecord[]>} The stored records, echoed back.
 */
export async function replaceZoneRecords(
  uid: string,
  domainName: string,
  records: DnsRecord[],
  firestore: Firestore = db(),
): Promise<DnsRecord[]> {
  await firestore.collection(COLLECTIONS.dnsZones).doc(domainName).set({
    uid,
    domainName,
    records,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return records;
}

/**
 * The mini resolver (§6.3.2 Lv2): finds the most specific zone the FQDN
 * falls under and answers from it. The most specific existing zone is
 * authoritative — a miss inside it does NOT fall through to a parent zone,
 * matching real DNS delegation. No ownership check on purpose: DNS data is
 * public by nature, and answers reflect the store immediately (no artificial
 * propagation delay).
 *
 * @param {string} fqdn Normalised FQDN (see {@link normaliseFqdn}).
 * @param {DnsRecordType} type Record type queried.
 * @param {Firestore} firestore Firestore handle, overridable for tests.
 * @return {Promise<DnsRecord[]>} Matching records; empty means "not found"
 *   and is NOT an error (the UI's「反映待ち」state, §6.3.3d).
 */
export async function resolveZoneRecords(
  fqdn: string,
  type: DnsRecordType,
  firestore: Firestore = db(),
): Promise<DnsRecord[]> {
  const candidates = zoneCandidatesFor(fqdn);
  if (candidates.length === 0) return [];
  const collection = firestore.collection(COLLECTIONS.dnsZones);
  const snapshots = await firestore.getAll(
    ...candidates.map((candidate) => collection.doc(candidate.zoneName)),
  );
  for (let i = 0; i < snapshots.length; i++) {
    const data = snapshots[i].data();
    if (!data) continue;
    return recordsMatching(
      sanitiseStoredRecords(data.records),
      candidates[i].relativeName,
      type,
    );
  }
  return [];
}
