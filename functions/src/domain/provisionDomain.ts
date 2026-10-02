/**
 * The registration use case: contact -> domain:create -> nameservers.
 *
 * This is the "PROV" box in FIG.1 and the whole of FIG.2. The interesting
 * part is not the happy path but the three exits:
 *
 *   1000                 -> done
 *   409 + 2302 + info    -> done, because a previous attempt of ours had
 *                           already succeeded (spec 6.7). This is what stops
 *                           "paid but no domain".
 *   timeout / 5xx        -> retrying, then failed once the attempt limit is
 *                           reached. Never a second charge.
 *
 * `domain:create` deliberately carries NO nameservers (design decision
 * 2026-08-26, "option A"). `nameservers` is optional on both registries'
 * DomainCreateRequest and a domain without one simply lands in the documented
 * `inactive` status (= ネームサーバ未設定), which the UI already has wording
 * for. Nameservers are attached afterwards with `domain:update`, outside the
 * irreversible create, and a refusal there is recorded but never fails the
 * order: a purchase must not be lost over a DNS detail the member can fix
 * later from the management screen.
 */
import * as logger from "firebase-functions/logger";
import {isRegistryError, RegistryError} from "../bridge/errors";
import {getRegistryClient} from "../bridge/registryRouter";
import {syncDomainRecord} from "./domainRecords";
import type {DomainInfo} from "../bridge/types";
import {orderClTrid} from "./clTrid";
import {
  ContactProfileInput,
  ensureRegistryContact,
} from "./contacts";
import {
  bumpAttempts,
  transitionOrder,
  type OrderHandle,
  type OrderState,
} from "./orders";

/** How many provisioning attempts an order gets before it is written off. */
export const ORDER_MAX_ATTEMPTS = 3;

/** Outcome of one provisioning run, shaped for the Callable response. */
export interface ProvisionResult {
  state: OrderState;
  domainName: string;
  registry: string;
  crDate?: string;
  exDate?: string;
  /** Nameservers the registry actually holds, not the ones that were asked
   * for: an order whose `domain:update` was refused reports none. */
  nameservers: string[];
  /** True when 2302 plus `domain:info` proved an earlier attempt worked. */
  recovered: boolean;
  /**
   * Present and true when the order asked for nameservers the registry did
   * not accept. The domain is registered and the order is `done`; only the
   * delegation is missing, so the UI can offer to set it again later.
   */
  nameserverUpdateFailed?: boolean;
  /** Message intended for the UI, already in Japanese. */
  message: string;
}

/** Wording for a completed registration. */
const DONE_MESSAGE = "ドメインの登録が完了しました。";

/** Wording when the domain is registered but still has no nameservers. */
const DONE_WITHOUT_NAMESERVERS_MESSAGE =
  "ドメインの登録が完了しました。" +
  "ネームサーバーは設定できなかったため、管理画面から改めて設定してください。";

/**
 * Persists the registered domain so the list screen has something to read.
 *
 * @param {OrderHandle} order Order that produced the domain.
 * @param {DomainInfo | undefined} info Latest known registry state.
 * @param {object} fresh Create timestamps plus the nameservers the registry
 *   really holds. Never the requested ones: a mirror that lists nameservers
 *   the registry rejected would send the member to a DNS screen for a
 *   delegation that does not exist.
 * @return {Promise<void>} Resolves once written.
 */
async function saveDomain(
  order: OrderHandle,
  info: DomainInfo | undefined,
  fresh: {crDate?: string; exDate?: string; nameservers: string[]},
): Promise<void> {
  const {uid, domainName, registry} = order.data;
  await syncDomainRecord(uid, domainName, info, {
    registry,
    orderId: order.id,
    registrant: order.data.registrantContactId ?? null,
    authInfo: order.data.authInfo ?? null,
    // The form's choice (§6.2.6 default ON); orders opened before the field
    // existed seed as ON, matching the old hard-coded behaviour.
    autoRenew: order.data.autoRenew ?? true,
    // On the plain-success path there is no domain:info to quote, but a
    // create that returned 1000 is certainly active. `inactive` is the one
    // status that follows from what we know rather than being guessed at
    // (RFC 5731 and both OpenAPI documents define it as "no nameserver
    // delegated"), and it is now the normal outcome of a purchase, so the
    // list screen has to be told about it. With nameservers in place the
    // array stays empty and the next life-cycle command fills it in.
    ...(info ? {} : {
      lifecycle: "active" as const,
      status: fresh.nameservers.length > 0 ? [] : ["inactive"],
      rgpStatus: [],
      nameservers: fresh.nameservers,
      crDate: fresh.crDate ?? null,
      exDate: fresh.exDate ?? null,
    }),
  });
}

/**
 * Decides whether a 2302 means "we already registered this" or "someone else
 * owns it".
 *
 * The only evidence available is the registrant contact id: our contact ids
 * are allocated by us and are unique inside our registrar, so a domain whose
 * registrant is our contact is a domain we registered.
 *
 * 🔬 To confirm in spec test 2 / test 7: whether `domain:info` returns full
 * data for a domain sponsored by a *different* registrar. If it does not,
 * the 404 branch below already covers it; if it returns a foreign
 * registrant, the comparison covers it. Either way we never claim a domain
 * that is not ours.
 *
 * @param {OrderHandle} order Order being provisioned.
 * @param {string} contactId Our registrant contact id on this registry.
 * @param {number} attempt Attempt number, for the clTRID.
 * @return {Promise<DomainInfo | undefined>} Info when the domain is ours.
 */
async function recoverExistingDomain(
  order: OrderHandle,
  contactId: string,
  attempt: number,
): Promise<DomainInfo | undefined> {
  const {domainName, registry} = order.data;
  const client = getRegistryClient(registry);
  try {
    const info = await client.infoDomain(
      domainName,
      orderClTrid(order.data.seq, "INFO", attempt),
    );
    if (info.registrant === contactId) return info;
    logger.warn("2302 but the domain belongs to another registrant", {
      domainName,
      registry,
      registrant: info.registrant,
      expected: contactId,
    });
    return undefined;
  } catch (error) {
    if (isRegistryError(error) && error.kind === "objectNotFound") {
      // Exists for the registry, invisible to us: not our domain.
      return undefined;
    }
    throw error;
  }
}

/** What the post-create nameserver step ended up doing. */
interface NameserverOutcome {
  /** Nameservers the registry holds once this step is over. */
  applied: string[];
  /** Why the requested nameservers are not among them, when they are not. */
  error?: Record<string, unknown>;
}

/**
 * Step 3 of FIG.1: attaches the requested nameservers with `domain:update`,
 * after the create, and never at its expense.
 *
 * The domain is already registered and paid for by the time this runs, so a
 * registry refusal (an unregistered host object, a malformed FQDN, a
 * transport error) is logged and reported, not thrown: the order stays `done`
 * with the domain in the registry's `inactive` status and the member sets the
 * nameservers later from the management screen. Issues no command at all for
 * the common case of an order that asked for none.
 *
 * @param {OrderHandle} order Order being provisioned.
 * @param {string[]} current Nameservers the registry has right now.
 * @param {number} attempt Attempt number, for the clTRID.
 * @return {Promise<NameserverOutcome>} What the registry holds afterwards.
 */
async function applyNameservers(
  order: OrderHandle,
  current: string[],
  attempt: number,
): Promise<NameserverOutcome> {
  const wanted = order.data.nameservers ?? [];
  const missing = wanted.filter((host) => !current.includes(host));
  if (missing.length === 0) return {applied: current};

  try {
    await getRegistryClient(order.data.registry).updateDomain(
      order.data.domainName,
      {add: {nameservers: missing}},
      orderClTrid(order.data.seq, "UPDATE", attempt),
      {uid: order.data.uid, orderId: order.id},
    );
    return {applied: [...current, ...missing]};
  } catch (error) {
    const payload = isRegistryError(error) ?
      error.toLogPayload() :
      {kind: "unknown", message: String(error)};
    logger.warn("nameservers not attached; the domain stays inactive", {
      orderId: order.id,
      domainName: order.data.domainName,
      registry: order.data.registry,
      requested: missing,
      ...payload,
    });
    return {applied: current, error: payload};
  }
}

/**
 * Runs one provisioning attempt for an order and moves its state.
 *
 * Safe to call again on the same order: a `done` order is returned as is, and
 * a `retrying` order picks up where it left off without charging again.
 *
 * @param {OrderHandle} order Order to provision.
 * @param {ContactProfileInput} contactInput Contact overrides from the form.
 * @return {Promise<ProvisionResult>} What the UI should show next.
 */
export async function provisionDomain(
  order: OrderHandle,
  contactInput: ContactProfileInput,
): Promise<ProvisionResult> {
  const {uid, domainName, registry} = order.data;

  if (order.data.state === "done") {
    return {
      state: "done",
      domainName,
      registry,
      crDate: order.data.result?.crDate,
      exDate: order.data.result?.exDate,
      // What the registry actually holds; `nameservers` on the order is only
      // what the form asked for. Orders opened before that distinction
      // existed have no `result.nameservers`, hence the fallback.
      nameservers:
        order.data.result?.nameservers ?? order.data.nameservers ?? [],
      recovered: order.data.result?.recovered ?? false,
      ...(order.data.result?.nameserverError ?
        {nameserverUpdateFailed: true} :
        {}),
      message: "このドメインの登録はすでに完了しています。",
    };
  }

  // A written-off order stays written off. Re-running it would issue another
  // registry command against an order the member has already been refunded
  // for; they have to place a new one.
  if (order.data.state === "failed") {
    return {
      state: "failed",
      domainName,
      registry,
      nameservers: [],
      recovered: false,
      message: "この注文は処理できませんでした。お手数ですが再度お申し込みください。",
    };
  }

  const attempt = await bumpAttempts(order);
  await transitionOrder(order, "provisioning");

  const client = getRegistryClient(registry);

  try {
    // (1) contact — created once per member per registry, then reused.
    //
    // Inside the try on purpose: a registry timeout here must become
    // `retrying` on the order exactly like one during domain:create. Left
    // outside, the exception would escape to the Callable and strand the
    // order in `provisioning`, a state nothing ever picks back up.
    const contact = await ensureRegistryContact(
      uid,
      registry,
      contactInput,
      order.id,
    );
    await transitionOrder(order, "provisioning", {
      registrantContactId: contact.contactId,
    });

    // (2) domain:create — never auto-retried at the transport level, and
    // deliberately without `nameservers`: nothing about DNS may stand between
    // a settled payment and a registered domain. The domain lands in
    // `inactive` and step (3) delegates it if the order asked for that.
    const outcome = await client.createDomain(
      {
        domain: domainName,
        period: {unit: "Y", value: order.data.periodYears},
        registrant: contact.contactId,
        contacts: {
          ADMIN: contact.contactId,
          TECH: contact.contactId,
        },
        authInfo: order.data.authInfo as string,
      },
      orderClTrid(order.data.seq, "CREATE", attempt),
      {uid, orderId: order.id},
    );

    if ("alreadyExisted" in outcome) {
      const info = await recoverExistingDomain(
        order,
        contact.contactId,
        attempt,
      );
      if (!info) {
        await transitionOrder(order, "failed", {
          error: {
            kind: "objectExists",
            message: "このドメインは既に他者が登録しています。",
          },
        });
        return {
          state: "failed",
          domainName,
          registry,
          nameservers: [],
          recovered: false,
          message:
            "このドメインは既に登録済みでした。お支払いは発生しません。",
        };
      }

      const ns = await applyNameservers(order, info.nameservers, attempt);
      await transitionOrder(order, "done", {
        result: {
          crDate: info.crDate,
          exDate: info.exDate ?? "",
          recovered: true,
          nameservers: ns.applied,
          ...(ns.error ? {nameserverError: ns.error} : {}),
        },
      });
      await saveDomain(order, {...info, nameservers: ns.applied}, {
        nameservers: ns.applied,
      });
      return {
        state: "done",
        domainName,
        registry,
        crDate: info.crDate,
        exDate: info.exDate,
        nameservers: ns.applied,
        recovered: true,
        ...(ns.error ? {nameserverUpdateFailed: true} : {}),
        message: ns.error ? DONE_WITHOUT_NAMESERVERS_MESSAGE : DONE_MESSAGE,
      };
    }

    // Plain success. The create carried no nameservers, so whatever the
    // registry holds now is exactly what step (3) puts there.
    const ns = await applyNameservers(order, [], attempt);
    await transitionOrder(order, "done", {
      result: {
        crDate: outcome.crDate,
        exDate: outcome.exDate,
        recovered: false,
        nameservers: ns.applied,
        ...(ns.error ? {nameserverError: ns.error} : {}),
      },
    });
    await saveDomain(order, undefined, {
      crDate: outcome.crDate,
      exDate: outcome.exDate,
      nameservers: ns.applied,
    });
    return {
      state: "done",
      domainName,
      registry,
      crDate: outcome.crDate,
      exDate: outcome.exDate,
      nameservers: ns.applied,
      recovered: false,
      ...(ns.error ? {nameserverUpdateFailed: true} : {}),
      message: ns.error ? DONE_WITHOUT_NAMESERVERS_MESSAGE : DONE_MESSAGE,
    };
  } catch (error) {
    return handleProvisionFailure(order, error, attempt);
  }
}

/**
 * Turns a failed attempt into either `retrying` or `failed`.
 *
 * @param {OrderHandle} order Order that failed.
 * @param {unknown} error Whatever was thrown.
 * @param {number} attempt Attempt number that failed.
 * @return {Promise<ProvisionResult>} What the UI should show next.
 */
async function handleProvisionFailure(
  order: OrderHandle,
  error: unknown,
  attempt: number,
): Promise<ProvisionResult> {
  const {domainName, registry} = order.data;
  const payload = isRegistryError(error) ?
    error.toLogPayload() :
    {kind: "unknown", message: String(error)};
  logger.error("provisioning failed", {orderId: order.id, ...payload});

  const retryable =
    error instanceof RegistryError ? error.retryable : false;
  const exhausted = attempt >= ORDER_MAX_ATTEMPTS;

  if (retryable && !exhausted) {
    await transitionOrder(order, "retrying", {error: payload});
    return {
      state: "retrying",
      domainName,
      registry,
      nameservers: [],
      recovered: false,
      message: "処理中です。自動で再試行しています。",
    };
  }

  await transitionOrder(order, "failed", {error: payload});
  return {
    state: "failed",
    domainName,
    registry,
    nameservers: [],
    recovered: false,
    message: retryable ?
      "時間内に処理できませんでした。お支払いは返金扱いになります。" :
      "処理できませんでした。お支払いは返金扱いになります。",
  };
}
