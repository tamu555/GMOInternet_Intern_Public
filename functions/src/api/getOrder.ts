/**
 * `getOrder` — the order-status poll behind FIG.1's right half, replacing
 * the functions-stubs implementation of the same name.
 *
 * Polling IS resuming, by design: a `retrying` (or stranded `provisioning`)
 * order is only ever advanced by re-entering `provisionDomain`/`renewDomain`
 * — both are built to be re-run safely on the same order without a second
 * charge, and nothing else (no cron) picks such orders up. A read-only poll
 * would therefore report `retrying` forever. So each poll of a non-terminal
 * order runs one more idempotent provisioning attempt; the attempt counter
 * (`ORDER_MAX_ATTEMPTS`) bounds the total registry work regardless of poll
 * cadence, after which the order settles as `failed`. Polling a `done` or
 * `failed` order is a pure Firestore read.
 *
 * Ownership: the order document id embeds the owner
 * (`{uid}__{idempotencyKey}`), and a missing order and another member's
 * order are both answered with the same `not-found` — existence must stay
 * unobservable to non-owners (spec 7.3).
 *
 * `domain.authInfo` is returned only on the caller's own COMPLETED create
 * order — the FIG.1 completion screen shows it masked, copy-only (§7.3).
 * This does not weaken the `getDomainInfo` decision (which still never
 * returns authInfo): the value here is the one the caller's own order form
 * supplied or was generated for it, scoped to that order.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS} from "../config/options";
import {
  isTerminal,
  type OrderDoc,
  type OrderHandle,
  type OrderKind,
  type OrderState,
} from "../domain/orders";
import {provisionDomain} from "../domain/provisionDomain";
import {renewDomain} from "../domain/renewDomain";
import {ValidationError} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** `domain` part of the response, present only when the order is done. */
export interface OrderResponseDomain {
  name: string;
  exDate: string;
  statuses: string[];
  authInfo: string;
}

/** Response returned to the client (the frontend `Order` type). */
export interface OrderResponse {
  id: string;
  kind: OrderKind;
  domainName: string;
  state: OrderState;
  years: number;
  autoRenew: boolean;
  priceYen: number;
  domain?: OrderResponseDomain;
  resultCode?: number;
}

/** Dependencies the handler needs, substitutable in tests. */
export interface GetOrderDependencies {
  loadOwnOrder(uid: string, orderId: string): Promise<OrderHandle | null>;
  resumeOrder(order: OrderHandle): Promise<void>;
}

/** Order ids are `{uid}__{idempotencyKey}`; both halves match this. */
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,190}$/;

/**
 * Loads the caller's own order. A missing document and one owned by a
 * different uid both come back as `null` (see module doc).
 *
 * @param {string} uid Caller uid.
 * @param {string} orderId Order document id.
 * @return {Promise<OrderHandle | null>} The owned order, or null.
 */
async function loadOwnOrder(
  uid: string,
  orderId: string,
): Promise<OrderHandle | null> {
  const ref = db().collection(COLLECTIONS.orders).doc(orderId);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data || data.uid !== uid) return null;
  return {id: orderId, ref, data: data as OrderDoc, isNew: false};
}

/**
 * Runs one more provisioning attempt for a non-terminal order. Both
 * resumers transition the order document themselves and update
 * `order.data` in place; business failures become order STATES here, never
 * exceptions (that is the whole point of the order flow).
 *
 * `provisionDomain`'s contact input is empty on purpose: the original
 * `createOrder` call already validated any overrides, and
 * `ensureRegistryContact` reuses the member's stored per-registry contact —
 * the same effective input a replayed `createOrder` would produce.
 *
 * @param {OrderHandle} order Non-terminal order to advance.
 * @return {Promise<void>} Resolves once the attempt settled a state.
 */
async function resumeOrder(order: OrderHandle): Promise<void> {
  if (order.data.kind === "renew") {
    await renewDomain(order);
    return;
  }
  await provisionDomain(order, {});
}

const defaultDependencies: GetOrderDependencies = {
  loadOwnOrder,
  resumeOrder,
};

/**
 * Projects an order document onto the frontend `Order` wire shape (the
 * contract the deleted stub established).
 *
 * @param {string} id Order document id.
 * @param {OrderDoc} data Order document, post-resume when one ran.
 * @return {OrderResponse} Wire-shaped order.
 */
export function serializeOrder(id: string, data: OrderDoc): OrderResponse {
  const response: OrderResponse = {
    id,
    kind: data.kind,
    domainName: data.domainName,
    state: data.state,
    years: data.periodYears,
    // Renewal never touches the flag; the screens that show it re-read the
    // domain (same convention the create/renew adapters already use).
    autoRenew: data.kind === "create" ? data.autoRenew ?? true : false,
    priceYen: data.priceYen,
  };

  if (data.state === "failed") {
    const code = (data.error as {resultCode?: unknown} | undefined)
      ?.resultCode;
    if (typeof code === "number") response.resultCode = code;
    return response;
  }
  if (data.state !== "done") return response;

  response.domain = {
    name: data.domainName,
    // spec §3.5: NS committed -> ok, none -> inactive (not published yet).
    statuses:
      data.kind === "create" && (data.nameservers ?? []).length === 0 ?
        ["inactive"] :
        ["ok"],
    exDate: data.result?.exDate ?? "",
    authInfo: data.kind === "create" ? data.authInfo ?? "" : "",
  };
  return response;
}

/**
 * Handles one `getOrder` invocation: auth → id validation → owner-scoped
 * load → resume when non-terminal → serialize.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {GetOrderDependencies} dependencies Injectable dependencies.
 * @return {Promise<OrderResponse>} Current (possibly just-advanced) order.
 */
export async function handleGetOrder(
  request: CallableRequest<unknown>,
  dependencies: GetOrderDependencies = defaultDependencies,
): Promise<OrderResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const uid = request.auth.uid;

  try {
    const raw = (request.data as {orderId?: unknown} | null | undefined)
      ?.orderId;
    if (typeof raw !== "string" || !ORDER_ID_PATTERN.test(raw.trim())) {
      throw new ValidationError("orderId", "orderId が不正です。");
    }
    const orderId = raw.trim();

    const order = await dependencies.loadOwnOrder(uid, orderId);
    if (!order) {
      throw new HttpsError("not-found", "対象の注文が見つかりません。");
    }

    if (!isTerminal(order.data)) {
      await dependencies.resumeOrder(order);
    }
    return serializeOrder(order.id, order.data);
  } catch (error) {
    throw toHttpsError(error, "getOrder");
  }
}

/**
 * Production `getOrder` Callable. Secrets and the raised timeout are needed
 * because polling a non-terminal order runs a real provisioning attempt
 * (see module doc); for settled orders this is a plain read.
 */
export const getOrder = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    return handleGetOrder(request);
  },
);
