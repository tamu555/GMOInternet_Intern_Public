/**
 * Wire types for the Kitaqsign / Kitaqnic EPP-over-REST API, plus the
 * normalised shapes the layers above BRIDGE are allowed to see.
 *
 * The wire types mirror the two OpenAPI documents exactly; the normalised
 * types are what hides the differences between the registries (spec 3.8).
 */
import type {RegistryId} from "../config/options";

/** EPP result codes used by this service (spec 3.3). */
export const EPP_RESULT = {
  SUCCESS: 1000,
  SUCCESS_ACTION_PENDING: 1001,
  OBJECT_EXISTS: 2302,
  OBJECT_DOES_NOT_EXIST: 2303,
  /** 2304 — the object's current status forbids the command. */
  STATUS_PROHIBITS_OPERATION: 2304,
  AUTH_ERROR: 2202,
  POLICY_VIOLATION: 2306,
} as const;

/**
 * `result` block of the common envelope.
 *
 * The OpenAPI schema names the text field `message`, while the prose examples
 * in the same document use `msg`. Both are accepted here on purpose.
 */
export interface EppResult {
  code: number;
  message?: string;
  msg?: string;
}

/** Transaction identifiers echoed back by the registry (spec 3.3). */
export interface EppTrId {
  clTRID?: string | null;
  svTRID: string;
}

/** The common JSON envelope every endpoint answers with. */
export interface EppEnvelope<T> {
  result: EppResult;
  resData?: T;
  extension?: Record<string, unknown>;
  trID: EppTrId;
}

/** Registration / renewal period. `unit` is `Y` or `M`. */
export interface EppPeriod {
  unit: "Y" | "M";
  value: number;
}

/** Request body of `POST /domains`. */
export interface DomainCreateRequest {
  domain: string;
  period: EppPeriod;
  nameservers?: string[];
  registrant: string;
  contacts?: Record<string, string>;
  authInfo: string;
  extensions?: Record<string, unknown>;
}

/** `resData` of a successful `POST /domains`. */
export interface DomainCreateResponse {
  domain: string;
  crDate: string;
  exDate: string;
}

/** Request body of `POST /domains/{name}/renew`. */
export interface DomainRenewRequest {
  curExpDate: string;
  period: EppPeriod;
}

/** `resData` of a successful `POST /domains/{name}/renew`. */
export interface DomainRenewResponse {
  domain: string;
  exDate: string;
}

/**
 * `resData` of `POST /domains/{name}/rotate-auth-info`.
 *
 * Both documents declare the same `RotateAuthInfoResponse` schema with
 * `authInfo` as its only — and required — member, and both describe the
 * endpoint identically: 「sponsoring registrar 向けの authInfo 再生成。新 raw
 * を 1 度だけ返し、旧 authInfo は即無効化される。」
 *
 * An earlier reading of the two documents recorded a difference here
 * (Kitaqsign `Map<String,String>` vs Kitaqnic `Map<String,Object>`; spec 3.8
 * 差分表), so the value is checked at runtime rather than trusted to be a
 * string — see `BaseRegistryClient.rotateAuthInfo`.
 */
export interface RotateAuthInfoResponse {
  authInfo: string;
}

/**
 * Request body of `POST /domains/{name}/transfer/request`.
 *
 * The OpenAPI schema (`DomainTransferRequest`) also allows `op` values
 * `approve` / `reject` / `cancel` / `query`, but each of those has its own
 * path and declares **no** request body, so only `request` is modeled here:
 * the path already says which operation is meant, and sending an `op` the
 * endpoint does not document would be inventing wire format.
 *
 * `period` is deliberately never populated by this service. The registries
 * accept it, but whether a transfer extends `exDate` (and therefore what it
 * should cost) is an open question in the spec (§6.6 / TBD #7), so the
 * registry's own default is used rather than a guess of ours.
 */
export interface DomainTransferRequest {
  op: "request";
  /** The transfer passphrase held by the losing registrar. 1-64 chars. */
  authInfo: string;
  period?: EppPeriod;
}

/**
 * `resData` of every `domain:transfer` endpoint.
 *
 * `reDate` / `acDate` are required by Kitaqnic's schema and absent from
 * Kitaqsign's, which is exactly the kind of difference BRIDGE absorbs: both
 * are optional here and normalised to `null` upwards (spec 3.8).
 */
export interface DomainTransferResponse {
  domain: string;
  /** Registry-worded transfer state, e.g. `pending` / `clientApproved`. */
  status: string;
  gainingRegistrar: string;
  losingRegistrar: string;
  /** Kitaqnic only: when the transfer was requested (ISO 8601). */
  reDate?: string;
  /** Kitaqnic only: when it was (or will be) actioned (ISO 8601). */
  acDate?: string;
}

/** One entry of `POST /domains/check`. */
export interface DomainCheckResult {
  name: string;
  avail: boolean;
  reason?: string;
}

/** `resData` of `POST /domains/check`. */
export interface DomainCheckResponse {
  results: DomainCheckResult[];
}

/**
 * `resData` of `GET /domains/{name}`.
 *
 * Kitaqsign calls this schema `DomainResponse` and Kitaqnic calls it
 * `DomainInfoResponse`; the fields we rely on are identical, which is why the
 * BRIDGE layer can expose a single normalised type (spec 3.8).
 */
export interface DomainInfoWire {
  domain: string;
  status: string[];
  registrant: string;
  contacts: Record<string, string>;
  nameservers: string[];
  period?: EppPeriod;
  crDate: string;
  upDate?: string | null;
  exDate?: string;
  trDate?: string | null;
  rgpStatus: string[];
  extensions?: DomainInfoExtensions;
}

/** Request body of `PUT /domains/{name}`. */
export interface DomainUpdateRequest {
  add?: DomainChangeSet;
  rem?: DomainChangeSet;
  chg?: {
    registrant?: string;
    authInfo?: string;
    extensions?: DomainUpdateExtensions;
  };
  extensions?: DomainUpdateExtensions;
}

/** `add` / `rem` payload of `domain:update`. */
export interface DomainChangeSet {
  nameservers?: string[];
  contacts?: Record<string, string>;
  statuses?: string[];
}

/** One DS record (RFC 4034 / RFC 5910). */
export interface EppDsData {
  keyTag: number;
  algorithm: number;
  digestType: number;
  digest: string;
}

// PROVISIONAL: unverified against live registry Swagger — see plan Step 0.
/**
 * `secDNS` extension payload for `domain:update`.
 *
 * Modeled on RFC 5910 `secDNS:update`'s `rem`/`add` shape: `rem.all` removes
 * every DS record, `rem.dsData` removes specific ones, `add.dsData` adds new
 * ones. Neither the registries' extension key name nor whether it lives
 * under `chg.extensions` or the top-level `extensions` is confirmed; both
 * `DomainUpdateRequest.chg.extensions` and `DomainUpdateRequest.extensions`
 * accept this shape so the Callable-layer builder can target whichever one
 * Step 0 verification confirms.
 */
export interface SecDnsUpdateExtension {
  rem?: {all: true} | {dsData: EppDsData[]};
  add?: {dsData: EppDsData[]};
}

// PROVISIONAL: unverified against live registry Swagger — see plan Step 0.
/** `secDNS` payload as it would appear on `DomainInfoWire.extensions`. */
export interface SecDnsInfoExtension {
  dsData: EppDsData[];
}

// PROVISIONAL: unverified against live registry Swagger — see plan Step 0.
/** Extension bag shared by `DomainUpdateRequest.chg.extensions` and the
 * top-level `DomainUpdateRequest.extensions`. */
export interface DomainUpdateExtensions extends Record<string, unknown> {
  secDNS?: SecDnsUpdateExtension;
}

// PROVISIONAL: unverified against live registry Swagger — see plan Step 0.
/** Extension bag on `DomainInfoWire.extensions`. */
export interface DomainInfoExtensions extends Record<string, unknown> {
  secDNS?: SecDnsInfoExtension;
}

/** Postal address. Only the redacted placeholder values are accepted. */
export interface EppAddress {
  street: string;
  city: string;
  sp?: string;
  pc?: string;
  cc: "JP" | "US";
}

/** Contact postal information. `name` must be one of the allowed aliases. */
export interface EppPostalInfo {
  name: string;
  org?: string;
  addr: EppAddress;
}

/** Request body of `POST /contacts`. */
export interface ContactCreateRequest {
  id: string;
  postalInfo: EppPostalInfo;
  voice?: string;
  fax?: string;
  email: string;
  authInfo: string;
}

/** `resData` of `POST /contacts` and `GET /contacts/{id}`. */
export interface ContactResponse {
  id: string;
  postalInfo: EppPostalInfo;
  voice?: string;
  fax?: string;
  email: string;
  status: string[];
  crDate: string;
  upDate?: string | null;
}

/** `chg` payload of `contact:update` (RFC 5733). */
export interface ContactChangeSet {
  postalInfo?: EppPostalInfo;
  voice?: string;
  fax?: string;
  email?: string;
}

// PROVISIONAL: unverified against live registry Swagger — see plan Step 0.
/**
 * Request body of `PUT /contacts/{id}`.
 *
 * Spec 3.9 lists the endpoint only, with no body shape. Modeled on
 * `DomainUpdateRequest`'s `chg` shape (RFC 5733 `contact:update`). This
 * feature always rebuilds every mutable field from a pre-update
 * `infoContact` call before issuing the PUT, so `chg` is populated in full
 * rather than as a partial patch, even though the wire shape technically
 * allows individual fields to be omitted. `status` add/rem is intentionally
 * not modeled: this feature does not expose contact status mutation.
 * `authInfo` is deliberately absent — rotation is a separate endpoint
 * (spec 3.9) and must never be reachable through `contact:update`.
 */
export interface ContactUpdateRequest {
  chg: ContactChangeSet;
}

/**
 * One IP address on a host object, as `IpAddress` in the registry OpenAPI
 * schema. `addr` carries the address string; `ip` is the version tag.
 * Verified against `docs/registry-kitaqsign-v1-openapi.yaml` (Kitaqnic is
 * identical for hosts).
 */
export interface EppHostAddress {
  addr: string;
  ip: "v4" | "v6";
}

/**
 * Request body of `POST /hosts` (`HostCreateRequest`).
 *
 * Verified against `docs/registry-kitaqsign-v1-openapi.yaml` (Kitaqnic is
 * identical for hosts).
 */
export interface HostCreateRequest {
  name: string;
  addrs?: EppHostAddress[];
}

/**
 * `resData` of `POST /hosts` and `GET /hosts/{name}` (`HostResponse`).
 *
 * Verified against `docs/registry-kitaqsign-v1-openapi.yaml` (Kitaqnic is
 * identical for hosts).
 */
export interface HostInfoWire {
  name: string;
  addrs: EppHostAddress[];
  status: string[];
  crDate: string;
  upDate?: string | null;
}

/** `add` / `rem` payload of `host:update` (RFC 5732 address changes only). */
export interface HostChangeSet {
  addrs?: EppHostAddress[];
}

/**
 * Request body of `PUT /hosts/{name}` (`HostUpdateRequest`).
 *
 * Verified against `docs/registry-kitaqsign-v1-openapi.yaml` (Kitaqnic is
 * identical for hosts). Rename (`chg.name`) is out of scope for this
 * feature — the architecture explicitly limits `host:update` to address
 * add/remove — so no `chg` field is modeled here.
 */
export interface HostUpdateRequest {
  add?: HostChangeSet;
  rem?: HostChangeSet;
}

/** One entry of the registry's poll queue, as it comes off the wire. */
export interface PollMessageDto {
  id: number;
  msgType: string;
  payload: Record<string, unknown>;
  qdate: string;
}

/**
 * `resData` of poll:req.
 *
 * `message` is absent when the queue is empty; `count` is the number of
 * unacked messages, including the one being returned (spec 3.7).
 */
export interface PollResponse {
  count: number;
  message?: PollMessageDto;
}

// --- normalised shapes exposed to the layers above BRIDGE -------------------

/** Result of `hello`, normalised across both registries. */
export interface RegistryGreeting {
  registry: RegistryId;
  registryCode?: string;
  tlds: string[];
  message?: string;
}

/** Availability of one name, tagged with the registry that answered. */
export interface DomainAvailability {
  name: string;
  registry: RegistryId;
  available: boolean;
  reason?: string;
}

/** Outcome of `domain:create`. */
export interface DomainCreateOutcome {
  domain: string;
  registry: RegistryId;
  crDate: string;
  exDate: string;
  clTRID: string;
  svTRID: string;
}

/**
 * Outcome of `domain:delete`.
 *
 * The command itself answers no `resData` worth having; what is worth keeping
 * is the registry's own restore deadline, which both documents put in the
 * envelope's extension bag rather than in the body: 「redemptionPeriod 期限の
 * 目安は extension.pendingDeleteUntil」.
 */
export interface DomainDeleteOutcome {
  domain: string;
  registry: RegistryId;
  /**
   * `extension.pendingDeleteUntil`, ISO 8601, or null when the registry did
   * not send one (it is documented as a hint, not a guarantee). The caller
   * falls back to `deletedAt` + the per-registry grace period.
   */
  pendingDeleteUntil: string | null;
  clTRID: string;
  svTRID: string;
}

/** Outcome of `domain:renew`. */
export interface DomainRenewOutcome {
  domain: string;
  registry: RegistryId;
  exDate: string;
  clTRID: string;
  svTRID: string;
}

/**
 * Outcome of any of the four `domain:transfer` commands, normalised across
 * both registries.
 *
 * One shape for all four operations on purpose: the caller already knows
 * which command it issued, and the registry answers each of them with the
 * same `DomainTransferResponse` body.
 */
export interface DomainTransferOutcome {
  domain: string;
  registry: RegistryId;
  /** Registry-worded transfer state, passed through untouched. */
  status: string;
  gainingRegistrar: string;
  losingRegistrar: string;
  /** Request timestamp, when the registry reported one. */
  requestedAt: string | null;
  /** Action timestamp, when the registry reported one. */
  actionedAt: string | null;
  clTRID: string;
  svTRID: string;
}

/**
 * Outcome of `domain:rotate authInfo`.
 *
 * The passphrase inside is the only copy there will ever be: the registry
 * mints it, answers it once, and invalidates whatever came before it. Nothing
 * above BRIDGE may store or log it — it exists to be handed straight to the
 * member who asked for it (spec 7.3).
 */
export interface AuthInfoRotation {
  domain: string;
  registry: RegistryId;
  /** The freshly minted transfer passphrase, 1-64 characters. */
  authInfo: string;
  clTRID: string;
  svTRID: string;
}

/** Normalised `domain:info`, identical for both registries. */
export interface DomainInfo {
  domain: string;
  registry: RegistryId;
  status: string[];
  registrant: string;
  contacts: Record<string, string>;
  nameservers: string[];
  crDate: string;
  upDate?: string | null;
  exDate?: string;
  trDate?: string | null;
  rgpStatus: string[];
  /** Recognised `secDNS` DS records, if the registry's answer carried any. */
  secDns?: EppDsData[];
}

/** Outcome of `contact:create`. */
export interface ContactCreateOutcome {
  contactId: string;
  registry: RegistryId;
  /** True when the registry answered 2302, i.e. it already existed. */
  alreadyExisted: boolean;
}

/** Normalised `contact:info`, identical for both registries. */
export interface ContactInfo {
  contactId: string;
  registry: RegistryId;
  postalInfo: EppPostalInfo;
  voice?: string;
  fax?: string;
  email: string;
  status: string[];
  crDate: string;
  upDate?: string | null;
}

/** Outcome of `host:create`. */
export interface HostCreateOutcome {
  name: string;
  registry: RegistryId;
  crDate: string;
  clTRID: string;
  svTRID: string;
}

/** Normalised `host:info`, identical for both registries. */
export interface HostInfo {
  name: string;
  registry: RegistryId;
  addresses: EppHostAddress[];
  status: string[];
  crDate: string;
  upDate?: string | null;
}

/** A poll message, tagged with the registry whose queue it came from. */
export interface PollMessage {
  /**
   * Registry-assigned id. Kept as a string: it is an int64 on the wire, and
   * it ends up in a Firestore document id.
   */
  id: string;
  registry: RegistryId;
  msgType: string;
  payload: Record<string, unknown>;
  qdate: string;
  /** Unacked messages left in the queue, including this one. */
  queueSize: number;
}
