/**
 * `createOrder` — the arrow out of the order form in FIG.1, and the whole of
 * FIG.2 from the API layer's side.
 *
 * The pseudo-payment settles the moment the order is opened; everything after
 * that is provisioning, and every exit from it is a state on the order rather
 * than an exception thrown at the UI. That is deliberate: "paid but no
 * domain" is the failure this flow exists to prevent (spec 6.7).
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {resolveRegistry} from "../bridge/registryRouter";
import {adhocClTrid} from "../domain/clTrid";
import {generateAuthInfo} from "../domain/authInfo";
import {openOrder, validateIdempotencyKey} from "../domain/orders";
import {priceForRegistration} from "../domain/pricing";
import {provisionDomain} from "../domain/provisionDomain";
import {
  buildContactEmail,
  normaliseContactName,
  normaliseDomainName,
  normaliseNameservers,
  normalisePeriodYears,
  validateAuthInfo,
} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Shape the React client sends. */
interface CreateOrderData {
  domainName?: string;
  periodYears?: number;
  nameservers?: string[];
  idempotencyKey?: string;
  authInfo?: string;
  /** Auto-renew choice from the form; defaults to ON (§6.2.6). */
  autoRenew?: boolean;
  contact?: {name?: string; emailLocalPart?: string};
}

/**
 * Registers a domain: opens the order, then runs contact -> create -> NS.
 *
 * The timeout is set well above the registry timeout so that a slow registry
 * surfaces as `retrying` on the order rather than as a dead invocation
 * (FIG.2).
 */
export const createOrder = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const data = (request.data ?? {}) as CreateOrderData;

      const domainName = normaliseDomainName(String(data.domainName ?? ""));
      const periodYears = normalisePeriodYears(data.periodYears);
      const nameservers = normaliseNameservers(data.nameservers);
      const idempotencyKey = validateIdempotencyKey(
        String(data.idempotencyKey ?? ""),
      );
      const authInfo = data.authInfo ?
        validateAuthInfo(String(data.authInfo)) :
        generateAuthInfo();
      const autoRenew = data.autoRenew === undefined ?
        true :
        Boolean(data.autoRenew);

      // Contact input is validated here, before the pseudo-payment settles.
      // ensureRegistryContact validates again when it builds the request,
      // but by then the order is open, and a validation failure at that
      // point would burn it as "failed" — a refund for a typo.
      normaliseContactName(data.contact?.name);
      if (data.contact?.emailLocalPart) {
        buildContactEmail(data.contact.emailLocalPart, "placeholder");
      }

      const registry = await resolveRegistry(
        domainName,
        adhocClTrid("ROUTE", uid.slice(0, 12)),
      );
      if (!registry) {
        throw new HttpsError(
          "invalid-argument",
          "このTLDは取り扱っていません。",
        );
      }

      const order = await openOrder({
        kind: "create",
        uid,
        idempotencyKey,
        domainName,
        registry,
        periodYears,
        nameservers,
        priceYen: priceForRegistration(domainName, periodYears),
        authInfo,
        autoRenew,
      });

      // A repeat submit must never open a second order for the same key, and
      // must never re-charge; it simply re-enters provisioning where the
      // first one left off.
      if (!order.isNew && order.data.kind !== "create") {
        throw new HttpsError(
          "invalid-argument",
          "この idempotencyKey は renew 用に使用済みです。",
        );
      }
      if (!order.isNew && order.data.domainName !== domainName) {
        throw new HttpsError(
          "invalid-argument",
          "この idempotencyKey は別のドメインで使用済みです。",
        );
      }

      const result = await provisionDomain(order, data.contact ?? {});

      return {
        orderId: order.id,
        orderSeq: order.data.seq,
        priceYen: order.data.priceYen,
        ...result,
      };
    } catch (error) {
      throw toHttpsError(error, "createOrder");
    }
  },
);
