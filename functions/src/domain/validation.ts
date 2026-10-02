/**
 * Input constraints imposed by the registries (spec 3.4).
 *
 * These are validated here, before any registry call, because a violation is
 * an unconditional HTTP 400 on the other side. The name and e-mail rules in
 * particular are the reason the UI must use a pulldown for the contact name
 * and a fixed domain suffix for the e-mail: free text is a guaranteed 400.
 *
 * The `normalise*Data` functions below additionally parse the four EPP
 * Update Callable DTOs (`updateDomain`/`updateContact`/`createHost`/
 * `updateHost`). They all reject unknown keys at every nesting level and any
 * `authInfo` field at any depth — `chg.authInfo` rotation is a separate,
 * dedicated endpoint (spec 3.9) and must never be reachable through these
 * DTOs (feature brief, "Exclude" section).
 */
import {isIP} from "node:net";
import {pad} from "./sequence";

/** The only contact names the registries accept. */
export const ALLOWED_CONTACT_NAMES = [
  "John Doe",
  "Jane Doe",
  "Taro Test",
  "Hanako Test",
  "Test User",
  "Demo User",
  "Sample Person",
  "Example Contact",
] as const;

/** The only e-mail domains the registries accept. */
export const ALLOWED_EMAIL_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
] as const;

/** Registration period bounds enforced by `domain:create`. */
export const MIN_PERIOD_YEARS = 1;
export const MAX_PERIOD_YEARS = 10;

/** Raised when a value would be rejected by the registry. */
export class ValidationError extends Error {
  readonly field: string;

  /**
   * @param {string} field Offending field name.
   * @param {string} message Human-readable reason.
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalises and validates a domain name against spec 3.4.
 *
 * @param {string} raw Domain name as the client sent it.
 * @return {string} Lower-cased, trimmed FQDN.
 */
export function normaliseDomainName(raw: string): string {
  const name = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!name) {
    throw new ValidationError("domainName", "ドメイン名が空です。");
  }
  if (name.length > 253) {
    throw new ValidationError(
      "domainName",
      "ドメイン名は253文字以内である必要があります。",
    );
  }
  const labels = name.split(".");
  if (labels.length < 2) {
    throw new ValidationError(
      "domainName",
      "ドメイン名にTLDが含まれていません。",
    );
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new ValidationError(
        "domainName",
        "各ラベルは1〜63文字である必要があります。",
      );
    }
    if (!LABEL_PATTERN.test(label)) {
      throw new ValidationError(
        "domainName",
        "英数字とハイフンのみ、ラベルの先頭と末尾にハイフンは使えません。",
      );
    }
  }
  return name;
}

/**
 * Validates the registration period.
 *
 * @param {number | undefined} years Requested number of years.
 * @return {number} Validated period in years.
 */
export function normalisePeriodYears(years: number | undefined): number {
  const value = years ?? MIN_PERIOD_YEARS;
  if (!Number.isInteger(value)) {
    throw new ValidationError("periodYears", "登録年数は整数で指定します。");
  }
  if (value < MIN_PERIOD_YEARS || value > MAX_PERIOD_YEARS) {
    throw new ValidationError(
      "periodYears",
      `登録年数は${MIN_PERIOD_YEARS}〜${MAX_PERIOD_YEARS}年です。`,
    );
  }
  return value;
}

/**
 * Validates a contact name against the allow-list.
 *
 * @param {string | undefined} raw Name chosen in the UI.
 * @return {string} A name the registry accepts.
 */
export function normaliseContactName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) return "Taro Test";
  const allowed = ALLOWED_CONTACT_NAMES as readonly string[];
  if (!allowed.includes(name)) {
    throw new ValidationError(
      "contact.name",
      "氏名は許可された値から選択してください: " + allowed.join(" / "),
    );
  }
  return name;
}

/**
 * Builds a contact e-mail from a local part, forcing an allowed domain.
 *
 * @param {string | undefined} localPart Local part entered in the UI.
 * @param {string} fallbackLocalPart Local part to use when none was given.
 * @return {string} Address the registry accepts.
 */
export function buildContactEmail(
  localPart: string | undefined,
  fallbackLocalPart: string,
): string {
  const local = (localPart ?? "").trim() || fallbackLocalPart;
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) {
    throw new ValidationError(
      "contact.emailLocalPart",
      "メールアドレスのローカル部に使えない文字が含まれています。",
    );
  }
  return `${local}@${ALLOWED_EMAIL_DOMAINS[0]}`;
}

const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Validates the nameserver list.
 *
 * @param {string[] | undefined} raw Hostnames as the client sent them.
 * @return {string[]} De-duplicated, lower-cased hostnames.
 */
export function normaliseNameservers(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const host = String(entry ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (host.length > 255 || !HOSTNAME_PATTERN.test(host)) {
      throw new ValidationError(
        "nameservers",
        `ネームサーバ名が不正です: ${entry}`,
      );
    }
    seen.add(host);
  }
  return [...seen];
}

/**
 * Validates an authInfo passphrase.
 *
 * @param {string} value Passphrase to check.
 * @return {string} The same value when it is acceptable.
 */
export function validateAuthInfo(value: string): string {
  if (value.length < 1 || value.length > 64) {
    throw new ValidationError(
      "authInfo",
      "authInfo は1〜64文字である必要があります。",
    );
  }
  return value;
}

/**
 * Validates the authInfo a member pastes into the transfer-in form.
 *
 * Separate from {@link validateAuthInfo} because the input here is untrusted
 * free text from a screen rather than a value this service generated: it is
 * coerced, trimmed and length-checked before it is ever put on the wire, and
 * the messages name the field the way the UI does (認証コード / AuthCode,
 * spec 6.6.2).
 *
 * The value is never logged or echoed back — it is the transfer credential.
 *
 * @param {unknown} raw Value as the client sent it.
 * @return {string} Trimmed passphrase the registry will accept.
 */
export function normaliseTransferAuthInfo(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError(
      "authInfo",
      "認証コード（AuthCode）を入力してください。",
    );
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new ValidationError(
      "authInfo",
      "認証コード（AuthCode）を入力してください。",
    );
  }
  if (value.length > 64) {
    throw new ValidationError(
      "authInfo",
      "認証コード（AuthCode）は64文字以内です。",
    );
  }
  return value;
}

/**
 * Validates the losing-side answer to a transfer request.
 *
 * @param {unknown} raw Value as the client sent it.
 * @return {"approve" | "reject"} The validated action.
 */
export function normaliseTransferAction(
  raw: unknown,
): "approve" | "reject" {
  if (raw === "approve" || raw === "reject") return raw;
  throw new ValidationError(
    "action",
    "action は approve / reject のいずれかです。",
  );
}

// --- EPP Update Callable DTO validation --------------------------------

/** The only domain statuses the app is allowed to set (spec 3.5). */
const CLIENT_STATUS_ALLOW_LIST = [
  "clientHold",
  "clientTransferProhibited",
  "clientUpdateProhibited",
  "clientDeleteProhibited",
  "clientRenewProhibited",
] as const;

/** A domain status this app may add/remove via `domain:update`. */
export type ClientDomainStatus = (typeof CLIENT_STATUS_ALLOW_LIST)[number];

/** Domain contact roles this app may add/remove via `domain:update`. */
const DOMAIN_CONTACT_ROLES = ["admin", "tech", "billing"] as const;

/** A domain contact role this app may add/remove via `domain:update`. */
export type DomainContactRole = (typeof DOMAIN_CONTACT_ROLES)[number];

/** One contact-role association to add or remove on a domain. */
export interface ValidatedContactRoleChange {
  role: DomainContactRole;
  contactId: string;
}

/** One validated DS record. */
export interface ValidatedDsData {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

/** Validated `change.secDns` payload for `domain:update`. */
export type ValidatedSecDnsChange =
  | {action: "replace"; dsData: ValidatedDsData[]}
  | {action: "removeAll"};

/** One IP address on a host, tagged with its normalised version. */
export interface HostAddress {
  ip: string;
  version: "v4" | "v6";
}

/** Validated `add` / `remove` block of `domain:update`. */
export interface ValidatedDomainChangeSet {
  nameservers?: string[];
  contacts?: ValidatedContactRoleChange[];
  statuses?: ClientDomainStatus[];
}

/** Validated `updateDomain` Callable input. */
export interface ValidatedDomainUpdate {
  operationId: string;
  domainName: string;
  add?: ValidatedDomainChangeSet;
  remove?: ValidatedDomainChangeSet;
  change?: {
    registrantContactId?: string;
    secDns?: ValidatedSecDnsChange;
  };
}

/** Validated `updateContact` Callable input. */
export interface ValidatedContactUpdate {
  operationId: string;
  contactId: string;
  contextDomainName: string;
  change: {
    name?: string;
    email?: string;
    voice?: string;
    fax?: string;
  };
}

/** Validated `createHost` Callable input. */
export interface ValidatedHostCreate {
  operationId: string;
  parentDomainName: string;
  hostName: string;
  addresses: HostAddress[];
}

/** Validated `updateHost` Callable input. */
export interface ValidatedHostUpdate {
  operationId: string;
  hostName: string;
  add?: {addresses: HostAddress[]};
  remove?: {addresses: HostAddress[]};
}

/**
 * Narrows an unknown value to a plain, non-array object.
 *
 * @param {unknown} value Value to check.
 * @param {string} field Field name, used in the thrown error.
 * @return {Record<string, unknown>} The same value, narrowed.
 */
function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(field, `${field} はオブジェクトで指定してください。`);
  }
  return value as Record<string, unknown>;
}

/**
 * Rejects any key not on the allow-list, at exactly one nesting level.
 *
 * Every `normalise*Data` entry point calls this once per object it parses,
 * which is what makes `authInfo` structurally unreachable at any depth: an
 * attacker cannot smuggle it into a nested object whose own keys are never
 * individually allow-listed.
 *
 * @param {Record<string, unknown>} obj Object to check.
 * @param {Array<string>} allowed Keys this object may contain.
 * @param {string} field Field name, used in the thrown error.
 * @return {void}
 */
function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(field, `未知のフィールドです: ${field}.${key}`);
    }
  }
}

/**
 * Defence-in-depth scan for an `authInfo` key at any nesting level.
 *
 * `assertKnownKeys` already makes `authInfo` unreachable as long as every
 * nested object level is allow-listed; this walk exists so the rejection is
 * explicit and does not silently depend on every future edit keeping every
 * allow-list in sync.
 *
 * @param {unknown} value Value to scan (object, array, or scalar).
 * @param {string} field Field name, used in the thrown error.
 * @return {void}
 */
function assertNoAuthInfo(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoAuthInfo(item, field);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key.toLowerCase() === "authinfo") {
        throw new ValidationError(
          field,
          "authInfo はこの操作では指定できません。",
        );
      }
      assertNoAuthInfo(nested, field);
    }
  }
}

/**
 * Validates the `operationId` every Update Callable DTO requires.
 *
 * @param {unknown} raw Value as the client sent it.
 * @param {string} field Field name, used in the thrown error.
 * @return {string} Trimmed operation id.
 */
function normaliseOperationId(raw: unknown, field = "operationId"): string {
  if (typeof raw !== "string") {
    throw new ValidationError(field, "operationId は文字列で指定してください。");
  }
  const value = raw.trim();
  if (value.length === 0 || value.length > 128) {
    throw new ValidationError(
      field,
      "operationId は1〜128文字である必要があります。",
    );
  }
  return value;
}

/**
 * Validates the `client*`-prefixed domain status allow-list.
 *
 * `server*` statuses and any other value are rejected outright: they are set
 * by the registry, never by this app (spec 3.5).
 *
 * @param {unknown} input Statuses as the client sent them.
 * @param {string} field Field name, used in the thrown error.
 * @return {ClientDomainStatus[]} Validated, de-duplicated statuses.
 */
export function validateClientStatuses(
  input: unknown,
  field = "statuses",
): ClientDomainStatus[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new ValidationError(field, `${field} は配列で指定してください。`);
  }
  const allowed = CLIENT_STATUS_ALLOW_LIST as readonly string[];
  const seen = new Set<string>();
  const result: ClientDomainStatus[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      throw new ValidationError(
        field,
        `許可されていないステータスです: ${String(entry)}`,
      );
    }
    if (seen.has(entry)) {
      throw new ValidationError(field, `ステータスが重複しています: ${entry}`);
    }
    seen.add(entry);
    result.push(entry as ClientDomainStatus);
  }
  return result;
}

/**
 * Validates a list of domain contact-role associations to add or remove.
 *
 * The role allow-list (`admin`/`tech`/`billing`) structurally excludes
 * `registrant`: registrant changes go through `change.registrantContactId`,
 * never through this add/remove path.
 *
 * @param {unknown} input Contact-role entries as the client sent them.
 * @param {string} field Field name, used in the thrown error.
 * @return {ValidatedContactRoleChange[]} Validated, de-duplicated entries.
 */
export function validateContactRoleChanges(
  input: unknown,
  field = "contacts",
): ValidatedContactRoleChange[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new ValidationError(field, `${field} は配列で指定してください。`);
  }
  const roles = DOMAIN_CONTACT_ROLES as readonly string[];
  const seen = new Set<string>();
  const result: ValidatedContactRoleChange[] = [];
  input.forEach((entry, index) => {
    const obj = asRecord(entry, `${field}[${index}]`);
    assertKnownKeys(obj, ["role", "contactId"], `${field}[${index}]`);
    const role = obj["role"];
    const contactId = obj["contactId"];
    if (typeof role !== "string" || !roles.includes(role)) {
      throw new ValidationError(
        `${field}[${index}].role`,
        `連絡先の役割が不正です: ${String(role)}`,
      );
    }
    if (typeof contactId !== "string" || contactId.trim().length === 0) {
      throw new ValidationError(
        `${field}[${index}].contactId`,
        "連絡先IDを指定してください。",
      );
    }
    const trimmedId = contactId.trim();
    const key = `${role}:${trimmedId}`;
    if (seen.has(key)) {
      throw new ValidationError(field, `連絡先の指定が重複しています: ${key}`);
    }
    seen.add(key);
    result.push({role: role as DomainContactRole, contactId: trimmedId});
  });
  return result;
}

/** Expected hex-digest length for each supported DS `digestType`. */
const DIGEST_HEX_LENGTHS: Record<number, number> = {
  1: 40, // SHA-1
  2: 64, // SHA-256
  3: 64, // GOST R 34.11-94
  4: 96, // SHA-384
};

/**
 * Validates one DS record.
 *
 * @param {unknown} input DS record as the client sent it.
 * @param {string} field Field name, used in the thrown error.
 * @return {ValidatedDsData} Validated record, digest lower-cased.
 */
function validateDsData(input: unknown, field: string): ValidatedDsData {
  const obj = asRecord(input, field);
  assertKnownKeys(
    obj,
    ["keyTag", "algorithm", "digestType", "digest"],
    field,
  );
  const {keyTag, algorithm, digestType, digest} = obj;

  if (
    typeof keyTag !== "number" ||
    !Number.isInteger(keyTag) ||
    keyTag < 0 ||
    keyTag > 65535
  ) {
    throw new ValidationError(
      `${field}.keyTag`,
      "keyTag は0〜65535の整数で指定してください。",
    );
  }
  if (
    typeof algorithm !== "number" ||
    !Number.isInteger(algorithm) ||
    algorithm < 0 ||
    algorithm > 255
  ) {
    throw new ValidationError(
      `${field}.algorithm`,
      "algorithm は0〜255の整数で指定してください。",
    );
  }
  if (typeof digestType !== "number" || !(digestType in DIGEST_HEX_LENGTHS)) {
    throw new ValidationError(
      `${field}.digestType`,
      "digestType が未対応の値です。",
    );
  }
  if (
    typeof digest !== "string" ||
    digest.length === 0 ||
    digest.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(digest)
  ) {
    throw new ValidationError(
      `${field}.digest`,
      "digest は偶数長の16進文字列で指定してください。",
    );
  }
  const expectedLength = DIGEST_HEX_LENGTHS[digestType];
  if (digest.length !== expectedLength) {
    throw new ValidationError(
      `${field}.digest`,
      `digestType ${digestType} の digest は${expectedLength}文字である必要があります。`,
    );
  }

  return {
    keyTag,
    algorithm,
    digestType,
    digest: digest.toLowerCase(),
  };
}

/**
 * Validates the `change.secDns` payload of `domain:update`.
 *
 * `removeAll` and `dsData` are mutually exclusive: `removeAll` must not
 * carry a `dsData` list, and `replace` must carry at least one record.
 *
 * @param {unknown} input secDNS change as the client sent it.
 * @param {string} field Field name, used in the thrown error.
 * @return {ValidatedSecDnsChange} Validated secDNS change.
 */
export function validateSecDns(
  input: unknown,
  field = "secDns",
): ValidatedSecDnsChange {
  const obj = asRecord(input, field);
  assertKnownKeys(obj, ["action", "dsData"], field);
  const action = obj["action"];

  if (action === "removeAll") {
    if (obj["dsData"] !== undefined) {
      throw new ValidationError(
        field,
        "removeAll のとき dsData は指定できません。",
      );
    }
    return {action: "removeAll"};
  }

  if (action !== "replace") {
    throw new ValidationError(
      `${field}.action`,
      "action は replace または removeAll のいずれかです。",
    );
  }
  const rawDsData = obj["dsData"];
  if (!Array.isArray(rawDsData) || rawDsData.length === 0) {
    throw new ValidationError(
      `${field}.dsData`,
      "replace のとき dsData を1件以上指定してください。",
    );
  }
  const seen = new Set<string>();
  const dsData = rawDsData.map((entry, index) => {
    const validated = validateDsData(entry, `${field}.dsData[${index}]`);
    const key =
      `${validated.keyTag}:${validated.algorithm}:` +
      `${validated.digestType}:${validated.digest}`;
    if (seen.has(key)) {
      throw new ValidationError(
        `${field}.dsData`,
        "dsData に重複するレコードがあります。",
      );
    }
    seen.add(key);
    return validated;
  });
  return {action: "replace", dsData};
}

/**
 * Validates and normalises a list of host IP addresses.
 *
 * @param {unknown} input Addresses as the client sent them.
 * @param {string} field Field name, used in the thrown error.
 * @return {HostAddress[]} Validated addresses, explicitly tagged v4/v6.
 */
export function normaliseHostAddresses(
  input: unknown,
  field = "addresses",
): HostAddress[] {
  if (!Array.isArray(input)) {
    throw new ValidationError(field, `${field} は配列で指定してください。`);
  }
  const seen = new Set<string>();
  const result: HostAddress[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new ValidationError(field, "アドレスは文字列で指定してください。");
    }
    const ip = entry.trim();
    const version = isIP(ip);
    if (version === 0) {
      throw new ValidationError(field, `IPアドレスが不正です: ${entry}`);
    }
    const key = ip.toLowerCase();
    if (seen.has(key)) {
      throw new ValidationError(field, `アドレスが重複しています: ${entry}`);
    }
    seen.add(key);
    result.push({ip, version: version === 4 ? "v4" : "v6"});
  }
  return result;
}

/**
 * Parses one `add` / `remove` block of `domain:update`.
 *
 * Rejects a block that is present but structurally empty: an `add: {}` (or
 * equivalent) carries no actual change and is treated the same as an
 * omitted block would have to be treated at the top level — a no-op that
 * must never reach the registry.
 *
 * @param {unknown} input Change-set as the client sent it, or undefined.
 * @param {string} field Field name (`add` or `remove`).
 * @return {ValidatedDomainChangeSet | undefined} Validated change-set.
 */
function parseDomainChangeSet(
  input: unknown,
  field: string,
): ValidatedDomainChangeSet | undefined {
  if (input === undefined) return undefined;
  const obj = asRecord(input, field);
  assertKnownKeys(obj, ["nameservers", "contacts", "statuses"], field);

  const result: ValidatedDomainChangeSet = {};

  if (obj["nameservers"] !== undefined) {
    if (!Array.isArray(obj["nameservers"])) {
      throw new ValidationError(
        `${field}.nameservers`,
        "ネームサーバは配列で指定してください。",
      );
    }
    const nameservers = normaliseNameservers(obj["nameservers"] as string[]);
    if (nameservers.length === 0) {
      throw new ValidationError(
        `${field}.nameservers`,
        "ネームサーバを1件以上指定してください。",
      );
    }
    result.nameservers = nameservers;
  }

  if (obj["contacts"] !== undefined) {
    const contacts = validateContactRoleChanges(
      obj["contacts"],
      `${field}.contacts`,
    );
    if (contacts.length === 0) {
      throw new ValidationError(
        `${field}.contacts`,
        "連絡先を1件以上指定してください。",
      );
    }
    result.contacts = contacts;
  }

  if (obj["statuses"] !== undefined) {
    const statuses = validateClientStatuses(
      obj["statuses"],
      `${field}.statuses`,
    );
    if (statuses.length === 0) {
      throw new ValidationError(
        `${field}.statuses`,
        "ステータスを1件以上指定してください。",
      );
    }
    result.statuses = statuses;
  }

  if (
    result.nameservers === undefined &&
    result.contacts === undefined &&
    result.statuses === undefined
  ) {
    throw new ValidationError(field, `${field} の内容が空です。`);
  }

  return result;
}

/**
 * Rejects the same nameserver / status / contact-role appearing in both the
 * `add` and `remove` blocks of one `domain:update` request.
 *
 * @param {ValidatedDomainChangeSet} add Validated `add` block.
 * @param {ValidatedDomainChangeSet} remove Validated `remove` block.
 * @return {void}
 */
function assertNoDomainAddRemoveConflict(
  add: ValidatedDomainChangeSet,
  remove: ValidatedDomainChangeSet,
): void {
  if (add.nameservers && remove.nameservers) {
    const addSet = new Set(add.nameservers);
    for (const ns of remove.nameservers) {
      if (addSet.has(ns)) {
        throw new ValidationError(
          "updateDomain",
          `同一ネームサーバを add と remove の両方に指定できません: ${ns}`,
        );
      }
    }
  }
  if (add.statuses && remove.statuses) {
    const addSet = new Set<string>(add.statuses);
    for (const status of remove.statuses) {
      if (addSet.has(status)) {
        throw new ValidationError(
          "updateDomain",
          `同一ステータスを add と remove の両方に指定できません: ${status}`,
        );
      }
    }
  }
  if (add.contacts && remove.contacts) {
    const addSet = new Set(
      add.contacts.map((c) => `${c.role}:${c.contactId}`),
    );
    for (const contact of remove.contacts) {
      const key = `${contact.role}:${contact.contactId}`;
      if (addSet.has(key)) {
        throw new ValidationError(
          "updateDomain",
          `同一連絡先を add と remove の両方に指定できません: ${key}`,
        );
      }
    }
  }
}

/**
 * Validates and normalises the `updateDomain` Callable input.
 *
 * @param {unknown} input Raw Callable request data.
 * @return {ValidatedDomainUpdate} Validated, normalised input.
 */
export function normaliseUpdateDomainData(
  input: unknown,
): ValidatedDomainUpdate {
  assertNoAuthInfo(input, "updateDomain");
  const obj = asRecord(input, "updateDomain");
  assertKnownKeys(
    obj,
    ["operationId", "domainName", "add", "remove", "change"],
    "updateDomain",
  );

  const operationId = normaliseOperationId(obj["operationId"]);
  if (typeof obj["domainName"] !== "string") {
    throw new ValidationError("domainName", "ドメイン名は文字列で指定してください。");
  }
  const domainName = normaliseDomainName(obj["domainName"]);

  const add = parseDomainChangeSet(obj["add"], "add");
  const remove = parseDomainChangeSet(obj["remove"], "remove");
  if (add && remove) assertNoDomainAddRemoveConflict(add, remove);

  let change: ValidatedDomainUpdate["change"];
  if (obj["change"] !== undefined) {
    const changeObj = asRecord(obj["change"], "change");
    assertKnownKeys(changeObj, ["registrantContactId", "secDns"], "change");

    const parsedChange: NonNullable<ValidatedDomainUpdate["change"]> = {};
    if (changeObj["registrantContactId"] !== undefined) {
      const registrantContactId = changeObj["registrantContactId"];
      if (
        typeof registrantContactId !== "string" ||
        registrantContactId.trim().length === 0
      ) {
        throw new ValidationError(
          "change.registrantContactId",
          "登録者の連絡先IDを指定してください。",
        );
      }
      parsedChange.registrantContactId = registrantContactId.trim();
    }
    if (changeObj["secDns"] !== undefined) {
      parsedChange.secDns = validateSecDns(
        changeObj["secDns"],
        "change.secDns",
      );
    }
    if (
      parsedChange.registrantContactId === undefined &&
      parsedChange.secDns === undefined
    ) {
      throw new ValidationError("change", "change の内容が空です。");
    }
    change = parsedChange;
  }

  if (!add && !remove && !change) {
    throw new ValidationError(
      "updateDomain",
      "add・remove・change のいずれかを指定してください。",
    );
  }

  return {operationId, domainName, add, remove, change};
}

/** EPP `voice` / `fax` format: `+CC.NNNNNNNNNNext` (RFC 5733). */
const VOICE_FAX_PATTERN = /^\+\d{1,3}\.\d{1,14}$/;

/**
 * Validates an EPP `voice` or `fax` value.
 *
 * @param {unknown} raw Value as the client sent it.
 * @param {string} field Field name, used in the thrown error.
 * @return {string} The validated value.
 */
function normaliseVoiceOrFax(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ValidationError(field, `${field} は文字列で指定してください。`);
  }
  const value = raw.trim();
  if (!VOICE_FAX_PATTERN.test(value)) {
    throw new ValidationError(
      field,
      `${field} の形式が不正です（例: +81.312345678）。`,
    );
  }
  return value;
}

/**
 * Validates and normalises the `updateContact` Callable input.
 *
 * `contextDomainName` is the caller-owned domain used to derive which
 * registry the contact belongs to (architecture: one user / one registry /
 * one contact today); it is not itself the object being changed.
 *
 * @param {unknown} input Raw Callable request data.
 * @return {ValidatedContactUpdate} Validated, normalised input.
 */
export function normaliseUpdateContactData(
  input: unknown,
): ValidatedContactUpdate {
  assertNoAuthInfo(input, "updateContact");
  const obj = asRecord(input, "updateContact");
  assertKnownKeys(
    obj,
    ["operationId", "contactId", "contextDomainName", "change"],
    "updateContact",
  );

  const operationId = normaliseOperationId(obj["operationId"]);
  const rawContactId = obj["contactId"];
  if (typeof rawContactId !== "string" || rawContactId.trim().length === 0) {
    throw new ValidationError("contactId", "連絡先IDを指定してください。");
  }
  const contactId = rawContactId.trim();

  if (typeof obj["contextDomainName"] !== "string") {
    throw new ValidationError(
      "contextDomainName",
      "対象ドメイン名は文字列で指定してください。",
    );
  }
  const contextDomainName = normaliseDomainName(obj["contextDomainName"]);

  const changeObj = asRecord(obj["change"], "change");
  assertKnownKeys(
    changeObj,
    ["name", "emailLocalPart", "voice", "fax"],
    "change",
  );

  const change: ValidatedContactUpdate["change"] = {};
  if (changeObj["name"] !== undefined) {
    if (typeof changeObj["name"] !== "string") {
      throw new ValidationError("change.name", "氏名は文字列で指定してください。");
    }
    change.name = normaliseContactName(changeObj["name"]);
  }
  if (changeObj["emailLocalPart"] !== undefined) {
    if (typeof changeObj["emailLocalPart"] !== "string") {
      throw new ValidationError(
        "change.emailLocalPart",
        "メールアドレスのローカル部は文字列で指定してください。",
      );
    }
    change.email = buildContactEmail(
      changeObj["emailLocalPart"],
      changeObj["emailLocalPart"],
    );
  }
  if (changeObj["voice"] !== undefined) {
    change.voice = normaliseVoiceOrFax(changeObj["voice"], "change.voice");
  }
  if (changeObj["fax"] !== undefined) {
    change.fax = normaliseVoiceOrFax(changeObj["fax"], "change.fax");
  }

  if (Object.keys(change).length === 0) {
    throw new ValidationError("change", "変更内容を1件以上指定してください。");
  }

  return {operationId, contactId, contextDomainName, change};
}

/**
 * Validates a single hostname field against the same pattern as
 * `normaliseNameservers`.
 *
 * @param {unknown} raw Value as the client sent it.
 * @param {string} field Field name, used in the thrown error.
 * @return {string} Lower-cased, trimmed hostname.
 */
function normaliseHostnameField(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ValidationError(field, `${field} は文字列で指定してください。`);
  }
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 255 || !HOSTNAME_PATTERN.test(host)) {
    throw new ValidationError(field, `ホスト名が不正です: ${raw}`);
  }
  return host;
}

/**
 * Validates and normalises the `createHost` Callable input.
 *
 * `hostName` must be a strict subdomain of `parentDomainName`: this feature
 * only ever creates in-bailiwick hosts for a domain the caller owns.
 *
 * @param {unknown} input Raw Callable request data.
 * @return {ValidatedHostCreate} Validated, normalised input.
 */
export function normaliseCreateHostData(input: unknown): ValidatedHostCreate {
  assertNoAuthInfo(input, "createHost");
  const obj = asRecord(input, "createHost");
  assertKnownKeys(
    obj,
    ["operationId", "parentDomainName", "hostName", "addresses"],
    "createHost",
  );

  const operationId = normaliseOperationId(obj["operationId"]);
  if (typeof obj["parentDomainName"] !== "string") {
    throw new ValidationError(
      "parentDomainName",
      "親ドメイン名は文字列で指定してください。",
    );
  }
  const parentDomainName = normaliseDomainName(obj["parentDomainName"]);
  const hostName = normaliseHostnameField(obj["hostName"], "hostName");

  if (hostName === parentDomainName) {
    throw new ValidationError(
      "hostName",
      "ホスト名は親ドメイン名と異なる必要があります。",
    );
  }
  if (!hostName.endsWith(`.${parentDomainName}`)) {
    throw new ValidationError(
      "hostName",
      "ホスト名は親ドメインのサブドメインである必要があります。",
    );
  }

  const addresses = normaliseHostAddresses(obj["addresses"]);
  if (addresses.length === 0) {
    throw new ValidationError("addresses", "アドレスを1件以上指定してください。");
  }

  return {operationId, parentDomainName, hostName, addresses};
}

/**
 * Parses one `add` / `remove` block of `updateHost`.
 *
 * @param {unknown} input Change-set as the client sent it, or undefined.
 * @param {string} field Field name (`add` or `remove`).
 * @return {{addresses: HostAddress[]} | undefined} Validated change-set.
 */
function parseHostChangeSet(
  input: unknown,
  field: string,
): {addresses: HostAddress[]} | undefined {
  if (input === undefined) return undefined;
  const obj = asRecord(input, field);
  assertKnownKeys(obj, ["addresses"], field);
  const addresses = normaliseHostAddresses(
    obj["addresses"],
    `${field}.addresses`,
  );
  if (addresses.length === 0) {
    throw new ValidationError(
      `${field}.addresses`,
      "アドレスを1件以上指定してください。",
    );
  }
  return {addresses};
}

/**
 * Validates and normalises the `updateHost` Callable input.
 *
 * Host rename is out of scope for this feature: `hostName` identifies the
 * host being updated and is never itself changed here.
 *
 * @param {unknown} input Raw Callable request data.
 * @return {ValidatedHostUpdate} Validated, normalised input.
 */
export function normaliseUpdateHostData(input: unknown): ValidatedHostUpdate {
  assertNoAuthInfo(input, "updateHost");
  const obj = asRecord(input, "updateHost");
  assertKnownKeys(
    obj,
    ["operationId", "hostName", "add", "remove"],
    "updateHost",
  );

  const operationId = normaliseOperationId(obj["operationId"]);
  const hostName = normaliseHostnameField(obj["hostName"], "hostName");

  const add = parseHostChangeSet(obj["add"], "add");
  const remove = parseHostChangeSet(obj["remove"], "remove");

  if (!add && !remove) {
    throw new ValidationError(
      "updateHost",
      "add または remove のいずれかを指定してください。",
    );
  }

  if (add && remove) {
    const addSet = new Set(add.addresses.map((a) => a.ip.toLowerCase()));
    for (const entry of remove.addresses) {
      if (addSet.has(entry.ip.toLowerCase())) {
        throw new ValidationError(
          "updateHost",
          `同一アドレスを add と remove の両方に指定できません: ${entry.ip}`,
        );
      }
    }
  }

  return {operationId, hostName, add, remove};
}

const EPP_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Truncates a registry-flavoured ISO datetime (`2027-08-27T03:02:41Z`) to
 * its UTC date part (`2027-08-27`); a value that is not a datetime is
 * returned trimmed but otherwise untouched.
 *
 * The real Kitaqsign/Kitaqnic registries answer `exDate` as a full ISO
 * datetime, while the EPP renew contract (and everything this codebase
 * derived from it) speaks date-only strings. Every renew-flow comparison or
 * validation of an expiry that came from the registry or the Firestore
 * mirror must pass through here first — string-comparing the two shapes
 * directly is what broke renewals against the real registries.
 *
 * @param {string} raw Registry- or mirror-sourced date or datetime string.
 * @return {string} The `YYYY-MM-DD` part when `raw` is a datetime,
 *   otherwise `raw` trimmed. Not validated — pair with `validateEppDate`.
 */
export function normaliseEppDateTime(raw: string): string {
  const value = String(raw ?? "").trim();
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : value;
}

/**
 * Validates a strict `YYYY-MM-DD` EPP date, rejecting datetime/timezone
 * suffixes and calendar-invalid dates such as `2028-02-30`.
 *
 * @param {string} raw Date string to validate.
 * @param {string} field Field name to attach to a validation error.
 * @return {string} The same string, once confirmed valid.
 */
export function validateEppDate(raw: string, field: string): string {
  const value = String(raw ?? "").trim();
  if (!EPP_DATE_PATTERN.test(value)) {
    throw new ValidationError(
      field,
      `${field} は YYYY-MM-DD 形式で指定してください。`,
    );
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError(field, `${field} は実在する日付ではありません。`);
  }
  return value;
}

/**
 * Computes the expected new expiry date after renewing for a number of
 * years, via UTC calendar-year addition (not a fixed 365-day-per-year
 * addition), so that e.g. `2028-02-29` (a leap day) plus one year rolls
 * forward to `2029-03-01` rather than landing on a non-existent date.
 *
 * @param {string} curExpDate Current expiry, `YYYY-MM-DD`.
 * @param {number} periodYears Years being added.
 * @return {string} The expected new expiry, `YYYY-MM-DD`.
 */
export function expectedRenewalExDate(
  curExpDate: string,
  periodYears: number,
): string {
  const validated = validateEppDate(curExpDate, "curExpDate");
  const [year, month, day] = validated.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(date.getUTCFullYear() + periodYears);
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  return `${y}-${m}-${d}`;
}
