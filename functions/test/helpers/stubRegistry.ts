/**
 * In-process stand-in for Kitaqsign / Kitaqnic.
 *
 * Modelled directly on the two OpenAPI documents: the same paths, the same
 * common envelope, and the same status codes (create answers 201, a duplicate
 * answers 409 + 2302, a missing registrant answers 404 + 2303). That fidelity
 * is what makes these tests worth running — a stub that always answered 200
 * would never exercise the two-stage judgement.
 *
 * Fault injection is explicit rather than triggered by magic domain names, so
 * a test says what it is simulating.
 */
import {createServer, type Server} from "node:http";
import {AddressInfo} from "node:net";

/** One request the stub received, for assertions. */
export interface RecordedCall {
  method: string;
  path: string;
  clTRID?: string;
  registrarId?: string;
  apiKey?: string;
  authorization?: string;
  body?: Record<string, unknown>;
}

/** One entry of the poll queue. */
interface StubMessage {
  id: number;
  msgType: string;
  payload: Record<string, unknown>;
  qdate: string;
}

/** An outstanding transfer request, as the stub holds it. */
interface StubTransfer {
  /** X-Registrar-Id that asked for the domain. */
  gaining: string;
  /** X-Registrar-Id that held it when the request came in. */
  losing: string;
  requestedAt: string;
}

/** A domain as the stub holds it. */
interface StubDomain {
  registrant: string;
  nameservers: string[];
  crDate: string;
  exDate: string;
  status: string[];
  rgpStatus: string[];
  /** X-Registrar-Id that holds the domain. `domain:restore` checks it. */
  sponsor: string;
  /** The transfer passphrase `domain:transfer request` is checked against. */
  authInfo: string;
  /** Set while a transfer is awaiting the losing registrar's answer. */
  transfer: StubTransfer | null;
}

/** Default passphrase seeded domains carry, so tests can quote one. */
export const STUB_AUTH_INFO = "stub-auth-info";

/** The four transfer endpoints, as they appear in the path. */
type TransferOperation = "request" | "approve" | "reject" | "cancel";

/**
 * The one `msgType` both registries document for transfer notifications
 * (`PollMessageDto`: 「移管に関する通知は domain:transfer」).
 */
export const TRANSFER_MSG_TYPE = "domain:transfer";

/**
 * Registrar id the tests authenticate as. Matches TEST_REGISTRAR_ID in
 * testEnv, so a domain created through the app is sponsored by "us".
 */
export const SELF_REGISTRAR = "KITAQ-TEST-001";

let svTridSeq = 0;
let rotationSeq = 0;

/**
 * Builds the common EPP envelope.
 *
 * @param {number} code EPP result code.
 * @param {string} message Result message.
 * @param {unknown} resData Command payload, if any.
 * @param {string | undefined} clTRID Client transaction id to echo.
 * @param {Record<string, unknown> | undefined} extension Registry-specific
 *   extension bag, as `domain:delete` uses for `pendingDeleteUntil`.
 * @return {object} Envelope body.
 */
function envelope(
  code: number,
  message: string,
  resData?: unknown,
  clTRID?: string,
  extension?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    result: {code, message},
    resData,
    ...(extension ? {extension} : {}),
    trID: {clTRID: clTRID ?? null, svTRID: `SV-${++svTridSeq}`},
  };
}

/** A running stub registry. */
export class StubRegistry {
  readonly registryCode: string;
  readonly tlds: string[];
  readonly calls: RecordedCall[] = [];

  /** Field name used for the TLD list in the hello payload. */
  helloTldField = "tlds";
  /** When true, hello fails (500), so the router has to fall back. */
  helloFails = false;
  /**
   * When true, every request — including hello — answers 503, the way a
   * registry does while restarting or in maintenance
   * (docs/仕様/registry-unavailable.md). Distinct from the 500-style faults
   * below, which simulate transient transport failures.
   */
  force503 = false;
  /** Milliseconds to stall every answer, for timeout tests. */
  delayMs = 0;
  /**
   * When true, any domain command naming a TLD outside `tlds` is refused with
   * the documented 「TLD ポリシー違反」 answer — HTTP 422 with `result.code`
   * 2306 (both OpenAPI documents: `POST /domains` and `POST /domains/check`
   * list 422 for exactly this, and the title line names the TLDs a registry
   * serves).
   *
   * Opt-in, because most suites let both stubs answer for any name and only
   * the cross-registry checks care who serves what. Note that `domain:info`
   * documents no 422 of its own, so a real registry may equally answer a
   * plain 404 for a TLD it does not serve; both readings have to lead to the
   * same outcome, which is why `confirmGoneAcrossRegistries` treats them
   * alike.
   */
  enforceTldPolicy = false;
  /** Status codes to return from the next `domain:create` calls. */
  private createFaults: number[] = [];
  /** Status codes to return from the next `contact:create` calls. */
  private contactFaults: number[] = [];
  /** Status codes to return from the next transfer commands. */
  private transferFaults: number[] = [];

  /**
   * Makes the next transfer commands fail at the transport level.
   *
   * @param {number} count How many commands to fail.
   * @param {number} status HTTP status to answer with.
   */
  failNextTransfers(count: number, status = 503): void {
    for (let i = 0; i < count; i++) this.transferFaults.push(status);
  }
  /** Status + EPP code to return from the next `domain:update` calls. */
  private updateFaults: [number, number][] = [];

  /**
   * How this registry spells poll:req and poll:ack. The two dialects are the
   * reason the BRIDGE layer exists (spec 3.8), so the stub speaks both rather
   * than a convenient middle ground.
   */
  dialect: "kitaqsign" | "kitaqnic" = "kitaqsign";
  /** When true, poll:ack answers 500 so the queue stays blocked. */
  ackFails = false;
  /**
   * When true, poll:ack answers 1000 but removes nothing. This is the nastier
   * shape of a blocked queue: the worker believes it succeeded and poll keeps
   * handing back the same head (spec 3.7).
   */
  ackSilentlyDoesNothing = false;
  /** When true, poll:req answers 500. */
  pollFails = false;
  /**
   * `extension.pendingDeleteUntil` on the `domain:delete` answer — the
   * registry's own hint for when `redemptionPeriod` ends. Settable so a test
   * can play a registry that sends none.
   */
  pendingDeleteUntil: string | null = "2026-10-10T00:00:00Z";

  /** Names to purge the instant the next `domain:info` has read them. */
  private readonly expireAfterInfo = new Set<string>();

  private readonly queue: StubMessage[] = [];
  private nextMessageId = 1;
  private readonly contacts = new Set<string>();
  private readonly domains = new Map<string, StubDomain>();
  private server?: Server;
  private port = 0;

  /**
   * @param {string} registryCode Short registry code, e.g. `KQSGN`.
   * @param {string[]} tlds TLDs this registry serves.
   */
  constructor(registryCode: string, tlds: string[]) {
    this.registryCode = registryCode;
    this.tlds = tlds;
  }

  /**
   * Starts listening on an ephemeral port.
   *
   * @return {Promise<string>} Base URL to point the BRIDGE layer at.
   */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const finish = (): void => {
          const [status, payload] = this.route(req.method ?? "GET",
            req.url ?? "/", raw, req.headers as Record<string, string>);
          res.writeHead(status, {"Content-Type": "application/json"});
          res.end(JSON.stringify(payload));
        };
        if (this.delayMs > 0) setTimeout(finish, this.delayMs);
        else finish();
      });
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server?.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  /** Stops the server. @return {Promise<void>} Resolves when closed. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Clears recorded calls, stored objects and injected faults. */
  reset(): void {
    this.calls.length = 0;
    this.contacts.clear();
    this.domains.clear();
    this.expireAfterInfo.clear();
    this.queue.length = 0;
    this.nextMessageId = 1;
    this.createFaults = [];
    this.contactFaults = [];
    this.transferFaults = [];
    this.updateFaults = [];
    this.delayMs = 0;
    this.helloFails = false;
    this.force503 = false;
    this.enforceTldPolicy = false;
    this.ackFails = false;
    this.ackSilentlyDoesNothing = false;
    this.pollFails = false;
    this.pendingDeleteUntil = "2026-10-10T00:00:00Z";
    this.helloTldField = "tlds";
  }

  /**
   * Appends a notification to the poll queue.
   *
   * @param {string} msgType Message type.
   * @param {Record<string, unknown>} payload Message body.
   * @param {number} withId Reuse this id instead of assigning a fresh one —
   *   how a real redelivery looks, since a registry redelivers the *same*
   *   message (same id) until it is acked.
   * @return {string} The id the registry assigned.
   */
  enqueueMessage(
    msgType: string,
    payload: Record<string, unknown> = {},
    withId?: number,
  ): string {
    const id = withId ?? this.nextMessageId++;
    this.queue.push({
      id,
      msgType,
      payload,
      qdate: `2026-08-25T10:00:${String(id).padStart(2, "0")}Z`,
    });
    return String(id);
  }

  /**
   * Queues a transfer notification for one registrar, in the documented shape
   * (`msgType: "domain:transfer"`, `payload: {op, domain,
   * counterpartyRegistrar}`).
   *
   * The stub keeps a single queue, and that queue is the one *this service*
   * polls, so a message addressed to the other registrar is simply not
   * queued: the registry routes each notification to the one registrar it
   * concerns (`request`/`cancel` → losing, `approve`/`reject` → gaining), and
   * a stub that handed us the other side's mail would let a test pass on a
   * message the real registry never delivers.
   *
   * @param {TransferOperation} op Operation that happened.
   * @param {string} domain Domain the notification is about.
   * @param {string} recipient Registrar the registry would notify.
   * @param {string} counterparty The other side, from the recipient's view.
   * @return {void}
   */
  private notifyTransfer(
    op: TransferOperation,
    domain: string,
    recipient: string,
    counterparty: string,
  ): void {
    if (recipient !== SELF_REGISTRAR) return;
    this.enqueueMessage(TRANSFER_MSG_TYPE, {
      op,
      domain,
      counterpartyRegistrar: counterparty,
    });
  }

  /**
   * How many messages are still unacked.
   *
   * @return {number} Queue length.
   */
  queueLength(): number {
    return this.queue.length;
  }

  /**
   * Makes the next `domain:create` calls fail at the transport level.
   *
   * @param {number} count How many calls to fail.
   * @param {number} status HTTP status to answer with.
   */
  failNextCreates(count: number, status = 500): void {
    for (let i = 0; i < count; i++) this.createFaults.push(status);
  }

  /**
   * Makes the next `contact:create` calls fail at the transport level.
   *
   * @param {number} count How many calls to fail.
   * @param {number} status HTTP status to answer with.
   */
  failNextContacts(count: number, status = 500): void {
    for (let i = 0; i < count; i++) this.contactFaults.push(status);
  }

  /**
   * Makes the next `domain:update` calls fail.
   *
   * The default is the refusal that matters most to the registration flow:
   * a nameserver whose host object the registry does not know answers
   * 404 / 2303 objectNotFound. That must cost the member their nameservers,
   * never their domain.
   *
   * @param {number} count How many calls to fail.
   * @param {number} status HTTP status to answer with.
   * @param {number} code EPP result code to answer with.
   */
  failNextUpdates(count: number, status = 404, code = 2303): void {
    for (let i = 0; i < count; i++) this.updateFaults.push([status, code]);
  }

  /**
   * Pre-registers a contact, as if an earlier run had created it.
   *
   * @param {string} id Contact id.
   */
  seedContact(id: string): void {
    this.contacts.add(id);
  }

  /**
   * Pre-registers a domain, as if someone else already owned it.
   *
   * @param {string} name Domain name.
   * @param {string} registrant Registrant contact id.
   * @param {string[]} nameservers Nameservers already on the domain.
   * @param {string} sponsor Registrar holding it, for restore's 403 branch.
   * @param {string} authInfo Transfer passphrase the domain carries.
   */
  seedDomain(
    name: string,
    registrant: string,
    nameservers: string[] = [],
    sponsor = SELF_REGISTRAR,
    authInfo = STUB_AUTH_INFO,
  ): void {
    this.contacts.add(registrant);
    this.domains.set(name, {
      registrant,
      nameservers: [...nameservers],
      crDate: "2026-08-01T00:00:00Z",
      exDate: "2027-08-01T00:00:00Z",
      status: nameservers.length > 0 ? ["ok"] : ["inactive"],
      rgpStatus: ["addPeriod"],
      sponsor,
      authInfo,
      transfer: null,
    });
  }

  /**
   * Puts a domain straight into the redemption window, as if it had been
   * deleted earlier, so a restore test does not have to delete it first.
   *
   * `redemptionPeriod` lands in `rgpStatus` by default, which is where this
   * stub's `domain:delete` puts it — but the registries' own prose lists it
   * among the `status` values, so `carriedIn` lets a test pin the other
   * reading. Nothing in the service may depend on which one it is.
   *
   * @param {string} name Domain name.
   * @param {string} registrant Registrant contact id.
   * @param {string} sponsor Registrar holding it.
   * @param {"rgpStatus" | "status"} carriedIn Array carrying
   *   `redemptionPeriod`.
   */
  seedPendingDelete(
    name: string,
    registrant: string,
    sponsor = SELF_REGISTRAR,
    carriedIn: "rgpStatus" | "status" = "rgpStatus",
  ): void {
    this.seedDomain(name, registrant, [], sponsor);
    const domain = this.domains.get(name) as StubDomain;
    domain.status = carriedIn === "status" ?
      ["pendingDelete", "redemptionPeriod"] :
      ["pendingDelete"];
    domain.rgpStatus = carriedIn === "status" ? [] : ["redemptionPeriod"];
  }

  /**
   * Runs the per-minute batch that ends the redemption window: after
   * `grace-period-days` (45) the registry drops `redemptionPeriod` and leaves
   * `pendingDelete` alone, which is no longer restorable — `domain:restore`
   * answers 2304 for the `pending-delete-days` (5) before the purge.
   *
   * @param {string} name Domain name.
   */
  endRedemptionPeriod(name: string): void {
    const domain = this.domains.get(name);
    if (!domain) throw new Error(`stub: no such domain ${name}`);
    domain.status = [
      ...domain.status.filter((entry) => entry !== "redemptionPeriod"),
    ];
    if (!domain.status.includes("pendingDelete")) {
      domain.status.push("pendingDelete");
    }
    domain.rgpStatus = domain.rgpStatus.filter(
      (entry) => entry !== "redemptionPeriod",
    );
  }

  /**
   * Runs one transfer endpoint as if a *different* registrar had called it —
   * the レジストラB role spec test 6 plays by hand in Swagger UI.
   *
   * Deliberately routed through the same `routeTransfer` the HTTP endpoint
   * uses, so the state a test seeds can never drift from the state the real
   * endpoint would have produced.
   *
   * @param {string} name Domain name.
   * @param {TransferOperation} operation Endpoint to run.
   * @param {string} caller X-Registrar-Id of the other registrar.
   * @return {number} HTTP status the endpoint answered with.
   */
  transferAs(
    name: string,
    operation: TransferOperation,
    caller: string,
  ): number {
    const domain = this.domains.get(name);
    if (!domain) throw new Error(`stub: no such domain ${name}`);
    const [status] = this.routeTransfer(
      name,
      operation,
      operation === "request" ?
        {op: "request", authInfo: domain.authInfo} :
        undefined,
      caller,
    );
    return status;
  }

  /**
   * Drops a domain entirely, the way the registry does once the grace period
   * runs out. Everything then answers 404 / 2303.
   *
   * @param {string} name Domain name.
   */
  expireGracePeriod(name: string): void {
    this.domains.delete(name);
  }

  /**
   * Purges a domain the moment the next `domain:info` has finished reading
   * it — the race a `domain:restore` runs into when the grace period ends
   * between the pre-read and the command itself, which is the only way to
   * reach restore's own 404 branch.
   *
   * @param {string} name Domain name.
   */
  expireAfterNextInfo(name: string): void {
    this.expireAfterInfo.add(name);
  }

  /**
   * Reads a stored domain.
   *
   * @param {string} name Domain name.
   * @return {StubDomain | undefined} Stored state, if present.
   */
  getDomain(name: string): StubDomain | undefined {
    return this.domains.get(name);
  }

  /**
   * Whether this registry serves the TLD of a name.
   *
   * @param {string} name Domain name.
   * @return {boolean} True when the TLD is in this registry's list.
   */
  private servesTld(name: string): boolean {
    const tld = name.toLowerCase().trim().split(".").pop() ?? "";
    return this.tlds.some(
      (entry) => entry.replace(/^\./, "").toLowerCase() === tld,
    );
  }

  /**
   * The `TLD ポリシー違反` answer, when `enforceTldPolicy` is on and the
   * request names a TLD this registry does not serve.
   *
   * @param {string} method HTTP method.
   * @param {string} path Path below `/api/v1/epp`.
   * @param {Record<string, unknown> | undefined} body Parsed request body.
   * @param {string | undefined} clTRID Client transaction id to echo.
   * @return {[number, Record<string, unknown>] | undefined} The refusal, or
   *   undefined when the request may proceed.
   */
  private tldPolicyRefusal(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    clTRID?: string,
  ): [number, Record<string, unknown>] | undefined {
    if (!this.enforceTldPolicy) return undefined;

    let names: string[] = [];
    if (path === "/domains/check") {
      names = (body?.names as string[]) ?? [];
    } else if (path === "/domains" && method === "POST") {
      names = [body?.domain as string].filter(Boolean);
    } else {
      const named = path.match(/^\/domains\/([^/]+)/);
      if (named) names = [decodeURIComponent(named[1])];
    }

    if (names.length === 0 || names.every((name) => this.servesTld(name))) {
      return undefined;
    }
    return [422, envelope(2306, "TLD policy violation", undefined, clTRID)];
  }

  /**
   * Counts recorded calls to one path suffix.
   *
   * @param {string} method HTTP method.
   * @param {string} path Path below `/api/v1/epp`.
   * @return {number} Number of matching calls.
   */
  countCalls(method: string, path: string): number {
    return this.calls.filter(
      (call) => call.method === method && call.path === path,
    ).length;
  }

  /**
   * Routes one request.
   *
   * @param {string} method HTTP method.
   * @param {string} url Full request URL.
   * @param {string} raw Raw request body.
   * @param {Record<string, string>} headers Request headers.
   * @return {[number, Record<string, unknown>]} Status and envelope.
   */
  private route(
    method: string,
    url: string,
    raw: string,
    headers: Record<string, string>,
  ): [number, Record<string, unknown>] {
    const path = new URL(url, "http://stub").pathname
      .replace("/api/v1/epp", "");
    const clTRID = headers["x-cl-trid"];
    const body = raw ?
      (JSON.parse(raw) as Record<string, unknown>) :
      undefined;

    this.calls.push({
      method,
      path,
      clTRID,
      registrarId: headers["x-registrar-id"],
      apiKey: headers["x-api-key"],
      authorization: headers["authorization"],
      body,
    });

    // A 503 rejects everything at the gate, before authentication — and the
    // body shape is deliberately not an EPP envelope, so tests prove the
    // client classifies on the HTTP status alone (registry-unavailable.md
    // M-1: the real 503 body is unmeasured and must not be relied on).
    if (this.force503) {
      return [503, {message: "service unavailable"}];
    }

    // Both authentication layers, exactly as the real registries apply them.
    if (!(headers["authorization"] ?? "").startsWith("Basic ")) {
      return [401, envelope(2200, "Basic gate rejected", undefined, clTRID)];
    }
    const needsApiKey = path !== "/sessions/hello";
    if (needsApiKey &&
      (!headers["x-registrar-id"] || !headers["x-api-key"])) {
      return [401, envelope(2200, "API key missing", undefined, clTRID)];
    }

    // The TLD is checked before the object is looked up, the way a registry
    // that does not serve the TLD has nothing to look the name up in.
    const refusal = this.tldPolicyRefusal(method, path, body, clTRID);
    if (refusal) return refusal;

    if (method === "GET" && path === "/sessions/hello") {
      if (this.helloFails) {
        return [500, envelope(2400, "unavailable", undefined, clTRID)];
      }
      return [200, envelope(1000, "ok", {
        registryCode: this.registryCode,
        [this.helloTldField]: this.tlds,
        message: "greetings",
      }, clTRID)];
    }

    if (method === "POST" && path === "/domains/check") {
      const names = (body?.names as string[]) ?? [];
      return [200, envelope(1000, "ok", {
        results: names.map((name) => ({
          name,
          avail: !this.domains.has(name),
          reason: this.domains.has(name) ? "in use" : undefined,
        })),
      }, clTRID)];
    }

    if (method === "POST" && path === "/contacts") {
      const contactFault = this.contactFaults.shift();
      if (contactFault) {
        return [contactFault,
          envelope(2400, "injected contact failure", undefined, clTRID)];
      }
      const id = body?.id as string;
      if (this.contacts.has(id)) {
        return [409, envelope(2302, "Object exists", undefined, clTRID)];
      }
      this.contacts.add(id);
      return [201, envelope(1000, "ok", {
        id,
        postalInfo: body?.postalInfo,
        email: body?.email,
        status: ["ok"],
        crDate: "2026-08-25T00:00:00Z",
      }, clTRID)];
    }

    if (method === "POST" && path === "/domains") {
      const fault = this.createFaults.shift();
      if (fault) {
        return [fault, envelope(2400, "injected failure", undefined, clTRID)];
      }
      const name = body?.domain as string;
      const registrant = body?.registrant as string;
      if (!this.contacts.has(registrant)) {
        return [404, envelope(2303, "registrant not found", undefined,
          clTRID)];
      }
      if (this.domains.has(name)) {
        return [409, envelope(2302, "Object exists", undefined, clTRID)];
      }
      const nameservers = (body?.nameservers as string[]) ?? [];
      this.domains.set(name, {
        registrant,
        nameservers: [...nameservers],
        crDate: "2026-08-25T10:00:00Z",
        exDate: "2027-08-25T10:00:00Z",
        status: nameservers.length > 0 ? ["ok"] : ["inactive"],
        rgpStatus: ["addPeriod"],
        sponsor: headers["x-registrar-id"] ?? SELF_REGISTRAR,
        authInfo: (body?.authInfo as string) ?? STUB_AUTH_INFO,
        transfer: null,
      });
      return [201, envelope(1000, "ok", {
        domain: name,
        crDate: "2026-08-25T10:00:00Z",
        exDate: "2027-08-25T10:00:00Z",
      }, clTRID)];
    }

    const match = path.match(/^\/domains\/([^/]+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const domain = this.domains.get(name);
      if (!domain) {
        return [404, envelope(2303, "not found", undefined, clTRID)];
      }
      if (method === "GET") {
        const answer = envelope(1000, "ok", {
          domain: name,
          status: domain.status,
          registrant: domain.registrant,
          contacts: {ADMIN: domain.registrant, TECH: domain.registrant},
          nameservers: domain.nameservers,
          crDate: domain.crDate,
          exDate: domain.exDate,
          rgpStatus: domain.rgpStatus,
        }, clTRID);
        if (this.expireAfterInfo.delete(name)) this.domains.delete(name);
        return [200, answer];
      }
      if (method === "PUT") {
        const updateFault = this.updateFaults.shift();
        if (updateFault) {
          const [status, code] = updateFault;
          return [status,
            envelope(code, "injected update failure", undefined, clTRID)];
        }
        const add = body?.add as {nameservers?: string[]} | undefined;
        for (const host of add?.nameservers ?? []) {
          domain.nameservers.push(host);
        }
        if (domain.nameservers.length > 0) domain.status = ["ok"];
        return [200, envelope(1000, "ok", undefined, clTRID)];
      }
      if (method === "DELETE") {
        // The domain is not erased: it gets `pendingDelete` *and* the RGP
        // `redemptionPeriod`, and stays restorable for grace-period-days.
        // Tests call endRedemptionPeriod() to run the 45-day batch and
        // expireGracePeriod() to purge the name.
        domain.status = ["pendingDelete"];
        domain.rgpStatus = ["redemptionPeriod"];
        // 「redemptionPeriod 期限の目安は extension.pendingDeleteUntil」.
        return [200, envelope(1000, "ok", undefined, clTRID, {
          pendingDeleteUntil: this.pendingDeleteUntil,
        })];
      }
    }

    // poll:req — always the oldest unacked message, one at a time, with the
    // unacked count alongside it (spec 3.7).
    const pollPath =
      this.dialect === "kitaqsign" ? "/messages/poll" : "/messages";
    if (method === "GET" && path === pollPath) {
      if (this.pollFails) {
        return [500, envelope(2400, "poll unavailable", undefined, clTRID)];
      }
      const head = this.queue[0];
      return [200, envelope(1000, "ok", {
        count: this.queue.length,
        message: head ? {...head} : undefined,
      }, clTRID)];
    }

    const ackMatch = path.match(/^\/messages\/([^/]+)(\/ack)?$/);
    if (ackMatch) {
      const wantsAck = this.dialect === "kitaqsign" ?
        method === "POST" && path.endsWith("/ack") :
        method === "DELETE" && !path.endsWith("/ack");
      if (wantsAck) {
        if (this.ackFails) {
          return [500, envelope(2400, "ack unavailable", undefined, clTRID)];
        }
        if (this.ackSilentlyDoesNothing) {
          return [200, envelope(1000, "ok", undefined, clTRID)];
        }
        const id = Number(ackMatch[1]);
        const index = this.queue.findIndex((entry) => entry.id === id);
        if (index === -1) {
          // Kitaqsign documents a 404 here; Kitaqnic documents only 200.
          return this.dialect === "kitaqsign" ?
            [404, envelope(2303, "no such message", undefined, clTRID)] :
            [200, envelope(1000, "ok", undefined, clTRID)];
        }
        this.queue.splice(index, 1);
        return [200, envelope(1000, "ok", undefined, clTRID)];
      }
    }

    const transferMatch = path.match(
      /^\/domains\/([^/]+)\/transfer\/(request|approve|reject|cancel)$/,
    );
    if (transferMatch && method === "POST") {
      return this.routeTransfer(
        decodeURIComponent(transferMatch[1]),
        transferMatch[2] as TransferOperation,
        body,
        headers["x-registrar-id"] ?? SELF_REGISTRAR,
        clTRID,
      );
    }

    // domain:rotate authInfo — 「新 raw を 1 度だけ返し、旧 authInfo は即無効
    // 化される」. Both documents give it the same path, the same empty request
    // and the same three answers: 200 with the new value, 403 for anyone but
    // the sponsoring registrar, 404 for an unknown name.
    const rotateMatch = path.match(/^\/domains\/([^/]+)\/rotate-auth-info$/);
    if (rotateMatch && method === "POST") {
      const name = decodeURIComponent(rotateMatch[1]);
      const domain = this.domains.get(name);
      if (!domain) {
        return [404, envelope(2303, "not found", undefined, clTRID)];
      }
      if (domain.sponsor !== (headers["x-registrar-id"] ?? SELF_REGISTRAR)) {
        return [403, envelope(2201, "not the sponsoring registrar",
          undefined, clTRID)];
      }
      // The old passphrase really stops working: it is replaced in the same
      // place `domain:transfer request` checks against, so a test can prove
      // the invalidation rather than take it on trust.
      domain.authInfo = `rotated-auth-info-${++rotationSeq}`;
      return [200, envelope(1000, "ok", {authInfo: domain.authInfo}, clTRID)];
    }

    const restoreMatch = path.match(/^\/domains\/([^/]+)\/restore$/);
    if (restoreMatch && method === "POST") {
      const name = decodeURIComponent(restoreMatch[1]);
      const domain = this.domains.get(name);
      if (!domain) {
        return [404, envelope(2303, "not found", undefined, clTRID)];
      }
      if (domain.sponsor !== (headers["x-registrar-id"] ?? SELF_REGISTRAR)) {
        return [403, envelope(2201, "not the sponsoring registrar",
          undefined, clTRID)];
      }
      // Documented: restore works only while the domain is in
      // `redemptionPeriod`. Once the 45-day batch has dropped it, the
      // remaining `pendingDelete` answers 2304 like any other wrong state.
      const inRedemption = domain.status.includes("redemptionPeriod") ||
        domain.rgpStatus.includes("redemptionPeriod");
      if (!inRedemption) {
        return [200, envelope(2304, "object status prohibits operation",
          undefined, clTRID)];
      }
      domain.status = domain.nameservers.length > 0 ? ["ok"] : ["inactive"];
      domain.rgpStatus = [];
      return [200, envelope(1000, "ok", undefined, clTRID)];
    }

    return [404, envelope(2303, "no such route", undefined, clTRID)];
  }

  /**
   * Serves the four `domain:transfer` endpoints (spec 6.6).
   *
   * The status codes follow the two OpenAPI documents: `request` answers 202
   * with a *pending* transfer (never a completed one), a wrong passphrase
   * answers 401 + 2202, and `approve` / `reject` / `cancel` answer 403 when
   * the caller is on the wrong side of the transfer and 409 when there is no
   * outstanding request to act on.
   *
   * Every accepted operation also queues the poll notification the registry
   * would send, in the documented shape and to the documented side only (see
   * `notifyTransfer`).
   *
   * The 20-minute auto-approve (spec 6.6.1) is deliberately not simulated:
   * these tests assert on what this service does, and a wall-clock timer
   * would make them slow and flaky. An auto-approve is played by having the
   * losing registrar approve; the registry notifies only the gaining side
   * either way, which is exactly the gap recorded in docs/FIXME/TODO.md.
   *
   * @param {string} name Domain name from the path.
   * @param {TransferOperation} operation Which endpoint was called.
   * @param {Record<string, unknown> | undefined} body Parsed request body.
   * @param {string} caller X-Registrar-Id of the calling registrar.
   * @param {string | undefined} clTRID Client transaction id to echo.
   * @return {[number, Record<string, unknown>]} Status and envelope.
   */
  private routeTransfer(
    name: string,
    operation: TransferOperation,
    body: Record<string, unknown> | undefined,
    caller: string,
    clTRID?: string,
  ): [number, Record<string, unknown>] {
    const transferFault = this.transferFaults.shift();
    if (transferFault) {
      return [transferFault,
        envelope(2400, "injected transfer failure", undefined, clTRID)];
    }
    const domain = this.domains.get(name);
    if (!domain) {
      return [404, envelope(2303, "not found", undefined, clTRID)];
    }

    /**
     * Builds the `DomainTransferResponse` both registries answer with.
     *
     * @param {string} status Transfer status word.
     * @param {string} gaining Gaining registrar id.
     * @param {string} losing Losing registrar id.
     * @param {string | undefined} requestedAt Request timestamp, if any.
     * @return {Record<string, unknown>} `resData` payload.
     */
    const transferResData = (
      status: string,
      gaining: string,
      losing: string,
      requestedAt?: string,
    ): Record<string, unknown> => ({
      domain: name,
      status,
      gainingRegistrar: gaining,
      losingRegistrar: losing,
      ...(requestedAt ? {reDate: requestedAt} : {}),
    });

    if (operation === "request") {
      if (domain.transfer) {
        return [409, envelope(2304, "transfer already pending", undefined,
          clTRID)];
      }
      if (domain.sponsor === caller) {
        return [403, envelope(2201, "already the sponsoring registrar",
          undefined, clTRID)];
      }
      if ((body?.authInfo as string) !== domain.authInfo) {
        return [401, envelope(2202, "invalid authInfo", undefined, clTRID)];
      }
      const requestedAt = "2026-08-26T10:00:00Z";
      domain.transfer = {
        gaining: caller,
        losing: domain.sponsor,
        requestedAt,
      };
      domain.status = [...domain.status.filter((s) => s !== "ok"),
        "pendingTransfer"];
      // The losing registrar is the one told that somebody wants its domain.
      this.notifyTransfer("request", name, domain.sponsor, caller);
      // 202 + 1001 (SUCCESS_ACTION_PENDING): accepted, not yet done.
      return [202, envelope(1001, "transfer pending",
        transferResData("pending", caller, domain.sponsor, requestedAt),
        clTRID)];
    }

    const pending = domain.transfer;
    if (!pending) {
      return [409, envelope(2303, "no transfer request", undefined, clTRID)];
    }

    // approve / reject belong to the losing registrar, cancel to the gaining
    // one. Anyone else gets 403 (spec 6.6.1).
    const allowed = operation === "cancel" ? pending.gaining : pending.losing;
    if (caller !== allowed) {
      return [403, envelope(2201, "not allowed to " + operation, undefined,
        clTRID)];
    }

    domain.transfer = null;
    domain.status = domain.status.filter((s) => s !== "pendingTransfer");
    if (domain.status.length === 0) {
      domain.status = domain.nameservers.length > 0 ? ["ok"] : ["inactive"];
    }

    if (operation === "approve") {
      domain.sponsor = pending.gaining;
      domain.rgpStatus = ["transferPeriod"];
    }

    // approve / reject are reported to the gaining side (the one waiting for
    // an answer), cancel to the losing side (the one that was asked).
    if (operation === "cancel") {
      this.notifyTransfer("cancel", name, pending.losing, pending.gaining);
    } else {
      this.notifyTransfer(operation, name, pending.gaining, pending.losing);
    }

    const status = {
      approve: "clientApproved",
      reject: "clientRejected",
      cancel: "clientCancelled",
    }[operation];
    return [200, envelope(1000, status,
      transferResData(status, pending.gaining, pending.losing,
        pending.requestedAt),
      clTRID)];
  }
}
