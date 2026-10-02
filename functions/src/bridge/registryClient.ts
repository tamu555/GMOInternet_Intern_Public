/**
 * The interface the layers above BRIDGE program against (spec 4.2).
 *
 * Callers never learn which registry answered beyond the `registry` tag on the
 * result. Anything that differs between Kitaqsign and Kitaqnic — response
 * schema names, HTTP status on create, the shape of `hello` — is absorbed by
 * the implementations in this directory.
 *
 * Only the commands this service actually issues are declared here; the point
 * of the interface is that a new one lands in exactly one place.
 */
import type {RegistryId} from "../config/options";
import {EppClient} from "./eppClient";
import {EPP_RESULT} from "./types";
import type {
  AuthInfoRotation,
  ContactCreateOutcome,
  PollMessage,
  PollResponse,
  ContactCreateRequest,
  ContactInfo,
  ContactResponse,
  ContactUpdateRequest,
  DomainAvailability,
  DomainCheckResponse,
  DomainCreateOutcome,
  DomainCreateRequest,
  DomainCreateResponse,
  DomainDeleteOutcome,
  DomainInfo,
  DomainInfoWire,
  DomainRenewOutcome,
  DomainRenewRequest,
  DomainRenewResponse,
  DomainTransferOutcome,
  DomainTransferRequest,
  DomainTransferResponse,
  DomainUpdateRequest,
  HostCreateOutcome,
  HostCreateRequest,
  HostInfo,
  HostInfoWire,
  HostUpdateRequest,
  RegistryGreeting,
  RotateAuthInfoResponse,
} from "./types";

/** Registry-agnostic client contract. */
export interface RegistryClient {
  readonly registry: RegistryId;

  /** `session:hello` — connectivity probe and TLD list. */
  hello(clTRID: string): Promise<RegistryGreeting>;

  /** `domain:check` — availability of one or more names. */
  checkDomains(
    names: string[],
    clTRID: string,
  ): Promise<DomainAvailability[]>;

  /** `domain:info`. Throws `objectNotFound` when the name is unknown. */
  infoDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainInfo>;

  /**
   * `domain:create`. Resolves normally on 2302 as well, with
   * `alreadyExisted` set, so the caller can run the recovery check.
   */
  createDomain(
    request: DomainCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainCreateOutcome | AlreadyExists>;

  /** `domain:update` — used here to set nameservers. */
  updateDomain(
    name: string,
    request: DomainUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void>;

  /**
   * `domain:renew`. Never retried: a repeat could double-renew, so the caller
   * reconciles an ambiguous result with `domain:info` instead.
   */
  renewDomain(
    name: string,
    request: DomainRenewRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainRenewOutcome>;

  /**
   * `domain:delete` — moves the domain into the RGP redemption window.
   *
   * It is not erased straight away: the domain gets `redemptionPeriod` *and*
   * `pendingDelete`, and `restoreDomain` can bring it back for
   * `grace-period-days` (45). After that the registry drops
   * `redemptionPeriod`, restore stops working, and the name is purged
   * `pending-delete-days` (5) later (spec 6.5).
   */
  deleteDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainDeleteOutcome>;

  /**
   * `domain:restore` — RGP restore of a domain in `redemptionPeriod`.
   *
   * Raises `forbidden` when we are not the sponsoring registrar, and
   * `statusProhibited` (2304) when the domain is not in `redemptionPeriod` —
   * which includes the non-restorable `pendingDelete` tail that follows it.
   */
  restoreDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void>;

  /**
   * `domain:rotate authInfo` — mints a new transfer passphrase for a domain
   * we sponsor, invalidating the previous one (both registries' 拡張,
   * spec 3.9).
   *
   * The answer carries the new value exactly once; there is no command that
   * reads it back, here or anywhere else. Only the sponsoring registrar may
   * call it (HTTP 403 otherwise), and an unknown name answers 404.
   */
  rotateAuthInfo(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<AuthInfoRotation>;

  /**
   * `domain:transfer request` — the gaining registrar asks for a domain it
   * does not hold, proving the member's claim with `authInfo` (spec 6.6).
   *
   * Answers HTTP 202 with a pending transfer rather than a completed one: the
   * losing registrar still has to approve, or 20 minutes have to elapse.
   */
  requestTransfer(
    name: string,
    request: DomainTransferRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome>;

  /**
   * `domain:transfer approve` — the losing registrar lets the domain go.
   * Only the sponsoring registrar may call it (HTTP 403 otherwise).
   */
  approveTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome>;

  /** `domain:transfer reject` — the losing registrar refuses. */
  rejectTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome>;

  /**
   * `domain:transfer cancel` — the gaining registrar withdraws its own
   * request, which is only possible before the losing side acts.
   */
  cancelTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome>;

  /** `contact:create`. Treats 2302 as "already there", not as a failure. */
  createContact(
    request: ContactCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<ContactCreateOutcome>;

  /** `contact:info`. Throws `objectNotFound` when the id is unknown. */
  infoContact(id: string, clTRID: string): Promise<ContactInfo>;

  /** `contact:update` — full-object rebuild, never a partial merge. */
  updateContact(
    id: string,
    request: ContactUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void>;

  /**
   * `host:create`. Unlike `createContact`, 2302 is never tolerated: an
   * existing host is never silently adopted into caller ownership.
   */
  createHost(
    request: HostCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<HostCreateOutcome>;

  /** `host:info`. Throws `objectNotFound` when the name is unknown. */
  infoHost(name: string, clTRID: string): Promise<HostInfo>;

  /** `host:update` — address add/remove only. Rename is out of scope. */
  updateHost(
    name: string,
    request: HostUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void>;

  /**
   * `poll:req` — the oldest unacked message, or null when the queue is empty.
   *
   * Always one message at a time, and always the oldest: nothing newer
   * arrives until this one is acked (spec 3.7).
   */
  pollMessage(clTRID: string): Promise<PollMessage | null>;

  /** `poll:ack` — removes one message from the queue. */
  ackMessage(id: string, clTRID: string): Promise<void>;
}

/** An HTTP method and path, as one registry spells it. */
export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
}

/** Correlation ids carried into the RegistryLog row. */
export interface CommandContext {
  uid?: string;
  orderId?: string;
}

/**
 * Reads a timestamp out of the untyped extension bag.
 *
 * The bag is `additionalProperties: object` in both documents, so nothing
 * guarantees the shape: anything that is not a parseable date string is
 * dropped rather than stored and shown as a deadline.
 *
 * @param {unknown} value Raw extension value.
 * @return {string | null} The value as-is when it is a usable timestamp.
 */
function isoStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** Returned by `createDomain` when the registry answered 2302. */
export interface AlreadyExists {
  alreadyExisted: true;
  domain: string;
  registry: RegistryId;
  clTRID: string;
  svTRID: string;
}

/**
 * Shared implementation. Both registries speak the same request bodies; only
 * the response envelopes and a couple of status codes differ, and those are
 * overridden in the subclasses.
 */
export abstract class BaseRegistryClient implements RegistryClient {
  readonly registry: RegistryId;
  protected readonly http: EppClient;

  /**
   * @param {RegistryId} registry Registry this client is bound to.
   */
  constructor(registry: RegistryId) {
    this.registry = registry;
    this.http = new EppClient(registry);
  }

  /** @inheritdoc */
  abstract hello(clTRID: string): Promise<RegistryGreeting>;

  /**
   * Where this registry serves poll:req.
   *
   * Kitaqsign uses `/messages/poll` and Kitaqnic uses `/messages`. That is
   * the whole difference, so it is expressed as a route rather than as two
   * copies of the polling logic.
   *
   * @return {Route} Method and path for poll:req.
   */
  protected abstract pollRoute(): Route;

  /**
   * Where this registry serves poll:ack.
   *
   * Here the registries differ in the verb as well as the path: Kitaqsign
   * wants `POST /messages/{id}/ack`, Kitaqnic wants `DELETE /messages/{id}`.
   * Presenting both as one `ackMessage(id)` is the direct answer to the
   * assignment's "absorb the differences between registries" (spec 3.8).
   *
   * @param {string} id Message id to acknowledge.
   * @return {Route} Method and path for poll:ack.
   */
  protected abstract ackRoute(id: string): Route;

  /** @inheritdoc */
  async pollMessage(clTRID: string): Promise<PollMessage | null> {
    const route = this.pollRoute();
    const answer = await this.http.send<PollResponse>({
      command: "poll:req",
      method: route.method,
      path: route.path,
      clTRID,
      // Re-reading the queue is safe: poll never consumes, only ack does.
      idempotent: true,
    });

    const message = answer.resData?.message;
    if (!message) return null;

    return {
      id: String(message.id),
      registry: this.registry,
      msgType: message.msgType,
      payload: message.payload ?? {},
      qdate: message.qdate,
      queueSize: answer.resData?.count ?? 0,
    };
  }

  /** @inheritdoc */
  async ackMessage(id: string, clTRID: string): Promise<void> {
    const route = this.ackRoute(id);
    await this.http.send<unknown>({
      command: "poll:ack",
      method: route.method,
      path: route.path,
      clTRID,
      // Acking twice is harmless — the second one finds nothing to remove —
      // and a queue stuck on an unacked message blocks every later
      // notification, so retrying is the lesser risk (spec 3.7).
      idempotent: true,
    });
  }

  /** @inheritdoc */
  async checkDomains(
    names: string[],
    clTRID: string,
  ): Promise<DomainAvailability[]> {
    const answer = await this.http.send<DomainCheckResponse>({
      command: "domain:check",
      method: "POST",
      path: "/domains/check",
      body: {names},
      clTRID,
      idempotent: true,
    });
    return (answer.resData?.results ?? []).map((result) => ({
      name: result.name,
      registry: this.registry,
      available: result.avail,
      reason: result.reason,
    }));
  }

  /** @inheritdoc */
  async infoDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainInfo> {
    const answer = await this.http.send<DomainInfoWire>({
      command: "domain:info",
      method: "GET",
      path: `/domains/${encodeURIComponent(name)}`,
      clTRID,
      idempotent: true,
      uid: context?.uid,
      orderId: context?.orderId,
    });
    const data = answer.resData;
    if (!data) {
      throw new Error(`domain:info returned no resData for ${name}`);
    }
    // Kitaqsign calls the schema DomainResponse and Kitaqnic calls it
    // DomainInfoResponse; the fields below exist on both (spec 3.8).
    return {
      domain: data.domain,
      registry: this.registry,
      status: data.status ?? [],
      registrant: data.registrant,
      contacts: data.contacts ?? {},
      nameservers: data.nameservers ?? [],
      crDate: data.crDate,
      upDate: data.upDate ?? null,
      exDate: data.exDate,
      trDate: data.trDate ?? null,
      rgpStatus: data.rgpStatus ?? [],
      // PROVISIONAL: unverified against live registry Swagger — see plan
      // Step 0. Only surfaced when the registry's answer actually carries a
      // recognised secDNS extension; DNSSEC reconciliation needs this typed
      // rather than buried in the untyped extensions bag.
      secDns: data.extensions?.secDNS?.dsData,
    };
  }

  /** @inheritdoc */
  async createDomain(
    request: DomainCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainCreateOutcome | AlreadyExists> {
    const answer = await this.http.send<DomainCreateResponse>({
      command: "domain:create",
      method: "POST",
      path: "/domains",
      body: request,
      clTRID,
      // Never auto-retried: a repeat could double-register. The recovery
      // path in the API layer handles a half-finished create (spec 6.7).
      idempotent: false,
      tolerate: [EPP_RESULT.OBJECT_EXISTS],
      uid: context?.uid,
      orderId: context?.orderId,
    });

    if (answer.resultCode === EPP_RESULT.OBJECT_EXISTS) {
      return {
        alreadyExisted: true,
        domain: request.domain,
        registry: this.registry,
        clTRID: answer.clTRID,
        svTRID: answer.svTRID,
      };
    }

    const data = answer.resData;
    if (!data) {
      throw new Error(
        `domain:create returned no resData for ${request.domain}`,
      );
    }
    return {
      domain: data.domain,
      registry: this.registry,
      crDate: data.crDate,
      exDate: data.exDate,
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /** @inheritdoc */
  async updateDomain(
    name: string,
    request: DomainUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    // Kitaqsign answers with DomainResponse and Kitaqnic with Unit. Callers
    // are given neither: they re-read with domain:info if they need state.
    await this.http.send<unknown>({
      command: "domain:update",
      method: "PUT",
      path: `/domains/${encodeURIComponent(name)}`,
      body: request,
      clTRID,
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });
  }

  /** @inheritdoc */
  async renewDomain(
    name: string,
    request: DomainRenewRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainRenewOutcome> {
    const answer = await this.http.send<DomainRenewResponse>({
      command: "domain:renew",
      method: "POST",
      path: `/domains/${encodeURIComponent(name)}/renew`,
      body: request,
      clTRID,
      // Never auto-retried: the caller reconciles an ambiguous result via
      // domain:info instead of resending a request that may have already
      // taken effect (spec 6.7 equivalent for renew).
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });

    const data = answer.resData;
    if (!data) {
      throw new Error(`domain:renew returned no resData for ${name}`);
    }
    return {
      domain: data.domain,
      registry: this.registry,
      exDate: data.exDate,
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /** @inheritdoc */
  async deleteDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainDeleteOutcome> {
    const answer = await this.http.send<unknown>({
      command: "domain:delete",
      method: "DELETE",
      path: `/domains/${encodeURIComponent(name)}`,
      clTRID,
      // Deleting twice is harmless at the registry, but a blind re-send after
      // a timeout would hide the fact that the first one may have landed.
      // The use case reconciles with domain:info instead.
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });

    return {
      domain: name,
      registry: this.registry,
      pendingDeleteUntil: isoStringOrNull(
        answer.extension?.pendingDeleteUntil,
      ),
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /** @inheritdoc */
  async restoreDomain(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    await this.http.send<unknown>({
      command: "domain:restore",
      method: "POST",
      path: `/domains/${encodeURIComponent(name)}/restore`,
      clTRID,
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });
  }

  /** @inheritdoc */
  async rotateAuthInfo(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<AuthInfoRotation> {
    const answer = await this.http.send<RotateAuthInfoResponse>({
      command: "domain:rotate authInfo",
      method: "POST",
      // Same path on both registries; the only documented difference is the
      // Java type their schema generator printed for the payload, which the
      // runtime check below absorbs (spec 3.8).
      path: `/domains/${encodeURIComponent(name)}/rotate-auth-info`,
      clTRID,
      // Never auto-retried, and for a harsher reason than the other
      // non-idempotent commands: every call mints a *new* secret and kills
      // the previous one, so a blind re-send after a timeout would leave the
      // member holding a passphrase the registry had already replaced. There
      // is nothing to reconcile with either — no command reads an authInfo
      // back — so an ambiguous outcome is reported rather than papered over.
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });

    const authInfo = answer.resData?.authInfo;
    if (typeof authInfo !== "string" || authInfo.length === 0) {
      // The schema marks `authInfo` required. An answer without a usable one
      // means the old passphrase may already be dead while we have no new
      // one to hand over, which the caller must hear about rather than read
      // as success.
      throw new Error(
        `domain:rotate authInfo returned no authInfo for ${name}`,
      );
    }

    return {
      domain: name,
      registry: this.registry,
      authInfo,
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /**
   * Issues one `domain:transfer` command and normalises the answer.
   *
   * All four operations share this body because the registries answer all
   * four with the same `DomainTransferResponse`; only the path segment and
   * (for `request`) the body differ.
   *
   * None of them is ever auto-retried. A blind re-send of `request` after a
   * timeout could raise a second transfer on a domain whose first request
   * already landed, and a re-sent `approve` could hand away a domain the
   * member has meanwhile decided to keep. The use case reconciles with
   * `domain:info` instead (spec 6.7's reasoning, applied to transfer).
   *
   * @param {string} operation Path segment: request/approve/reject/cancel.
   * @param {string} name Domain the command acts on.
   * @param {DomainTransferRequest | undefined} body Request payload, which
   *   only `request` has.
   * @param {string} clTRID Transaction id.
   * @param {CommandContext | undefined} context Correlation ids for the log.
   * @return {Promise<DomainTransferOutcome>} Normalised transfer state.
   */
  private async sendTransfer(
    operation: "request" | "approve" | "reject" | "cancel",
    name: string,
    body: DomainTransferRequest | undefined,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome> {
    const answer = await this.http.send<DomainTransferResponse>({
      command: `domain:transfer ${operation}`,
      method: "POST",
      path: `/domains/${encodeURIComponent(name)}/transfer/${operation}`,
      ...(body === undefined ? {} : {body}),
      clTRID,
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });

    const data = answer.resData;
    if (!data) {
      throw new Error(
        `domain:transfer ${operation} returned no resData for ${name}`,
      );
    }
    return {
      domain: data.domain,
      registry: this.registry,
      status: data.status,
      gainingRegistrar: data.gainingRegistrar,
      losingRegistrar: data.losingRegistrar,
      requestedAt: data.reDate ?? null,
      actionedAt: data.acDate ?? null,
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /** @inheritdoc */
  requestTransfer(
    name: string,
    request: DomainTransferRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome> {
    return this.sendTransfer("request", name, request, clTRID, context);
  }

  /** @inheritdoc */
  approveTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome> {
    return this.sendTransfer("approve", name, undefined, clTRID, context);
  }

  /** @inheritdoc */
  rejectTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome> {
    return this.sendTransfer("reject", name, undefined, clTRID, context);
  }

  /** @inheritdoc */
  cancelTransfer(
    name: string,
    clTRID: string,
    context?: CommandContext,
  ): Promise<DomainTransferOutcome> {
    return this.sendTransfer("cancel", name, undefined, clTRID, context);
  }

  /** @inheritdoc */
  async createContact(
    request: ContactCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<ContactCreateOutcome> {
    // Kitaqsign answers 201 and Kitaqnic 200; both are accepted as 2xx.
    const answer = await this.http.send<ContactResponse>({
      command: "contact:create",
      method: "POST",
      path: "/contacts",
      body: request,
      clTRID,
      idempotent: false,
      // Deterministic contact ids mean 2302 says "we already made this one"
      // rather than "someone took the name" (spec 5.1, 6.8).
      tolerate: [EPP_RESULT.OBJECT_EXISTS],
      uid: context?.uid,
      orderId: context?.orderId,
    });
    return {
      contactId: request.id,
      registry: this.registry,
      alreadyExisted: answer.resultCode === EPP_RESULT.OBJECT_EXISTS,
    };
  }

  /** @inheritdoc */
  async infoContact(id: string, clTRID: string): Promise<ContactInfo> {
    const answer = await this.http.send<ContactResponse>({
      command: "contact:info",
      method: "GET",
      path: `/contacts/${encodeURIComponent(id)}`,
      clTRID,
      idempotent: true,
    });
    const data = answer.resData;
    if (!data) {
      throw new Error(`contact:info returned no resData for ${id}`);
    }
    return {
      contactId: data.id,
      registry: this.registry,
      postalInfo: data.postalInfo,
      voice: data.voice,
      fax: data.fax,
      email: data.email,
      status: data.status ?? [],
      crDate: data.crDate,
      upDate: data.upDate ?? null,
    };
  }

  /** @inheritdoc */
  async updateContact(
    id: string,
    request: ContactUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    await this.http.send<unknown>({
      command: "contact:update",
      method: "PUT",
      path: `/contacts/${encodeURIComponent(id)}`,
      body: request,
      clTRID,
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });
  }

  /** @inheritdoc */
  async createHost(
    request: HostCreateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<HostCreateOutcome> {
    const answer = await this.http.send<HostInfoWire>({
      command: "host:create",
      method: "POST",
      path: "/hosts",
      body: request,
      clTRID,
      // 2302 is not tolerated: a caller must never end up owning a host
      // created by someone else (architecture decision, spec 6.7 analogue).
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });
    return {
      name: request.name,
      registry: this.registry,
      crDate: answer.resData?.crDate ?? "",
      clTRID: answer.clTRID,
      svTRID: answer.svTRID,
    };
  }

  /** @inheritdoc */
  async infoHost(name: string, clTRID: string): Promise<HostInfo> {
    const answer = await this.http.send<HostInfoWire>({
      command: "host:info",
      method: "GET",
      path: `/hosts/${encodeURIComponent(name)}`,
      clTRID,
      idempotent: true,
    });
    const data = answer.resData;
    if (!data) {
      throw new Error(`host:info returned no resData for ${name}`);
    }
    return {
      name: data.name,
      registry: this.registry,
      addresses: data.addrs ?? [],
      status: data.status ?? [],
      crDate: data.crDate,
      upDate: data.upDate ?? null,
    };
  }

  /** @inheritdoc */
  async updateHost(
    name: string,
    request: HostUpdateRequest,
    clTRID: string,
    context?: CommandContext,
  ): Promise<void> {
    await this.http.send<unknown>({
      command: "host:update",
      method: "PUT",
      path: `/hosts/${encodeURIComponent(name)}`,
      body: request,
      clTRID,
      idempotent: false,
      uid: context?.uid,
      orderId: context?.orderId,
    });
  }
}
