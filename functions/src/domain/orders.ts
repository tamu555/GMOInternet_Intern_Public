/**
 * Order persistence and its state machine (spec 5, TBD #17).
 *
 *   draft -> paid -> provisioning -> done
 *                          |
 *                          +-> retrying --(2302 + info = it worked)--> done
 *                          |
 *                          +-> failed   (refund; "処理できませんでした")
 *
 * The document id is `${uid}__${idempotencyKey}`, which is what makes the
 * flow safe against a double-submitted form: a repeat lands on the same
 * document instead of creating a second charge (FIG.1, "二重課金しない").
 */
import {FieldValue, type DocumentReference} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {nextSequence} from "./sequence";
import {ValidationError} from "./validation";

/** States an order can be in. */
export type OrderState =
  | "draft"
  | "paid"
  | "provisioning"
  | "done"
  | "retrying"
  | "failed";

/** States from which no further work happens. */
const TERMINAL_STATES: OrderState[] = ["done", "failed"];

/** Discriminant for what an order provisions. */
export type OrderKind = "create" | "renew";

/** Stored shape of an order. */
export interface OrderDoc {
  uid: string;
  seq: number;
  kind: OrderKind;
  domainName: string;
  registry: RegistryId;
  periodYears: number;
  /**
   * Nameservers the form asked for. Part of the request, not of the outcome:
   * what the registry ended up holding is `result.nameservers`, which is the
   * field every reader that cares about reality must use.
   */
  nameservers: string[];
  priceYen: number;
  state: OrderState;
  attempts: number;
  idempotencyKey: string;
  registrantContactId?: string;
  authInfo?: string;
  /**
   * Create only: the auto-renew choice from the order form (§6.2.6 default
   * ON). Seeds the domain mirror's flag on provisioning; absent on orders
   * opened before this field existed (treated as true).
   */
  autoRenew?: boolean;
  /** Renew only: the domain's expiry snapshot at order-open time. */
  curExpDate?: string;
  /** Renew only: the client-computed expiry the registry must confirm. */
  expectedExDate?: string;
  result?: {
    /** Absent for renew, whose result has no creation date. */
    crDate?: string;
    exDate: string;
    recovered: boolean;
    /**
     * Create only: the nameservers the registry actually holds. Empty when
     * the order asked for none, and also when it asked for some and the
     * post-create `domain:update` was refused — see `nameserverError`.
     */
    nameservers?: string[];
    /**
     * Create only, and only when the post-create `domain:update` failed: why
     * the requested nameservers are not on the domain. The order is still
     * `done` — the registration succeeded, the delegation did not.
     */
    nameserverError?: Record<string, unknown>;
  };
  error?: Record<string, unknown>;
}

/** An order together with the handle needed to update it. */
export interface OrderHandle {
  id: string;
  ref: DocumentReference;
  data: OrderDoc;
  /** False when an identical request had already created this order. */
  isNew: boolean;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Validates the client-supplied idempotency key.
 *
 * The key is part of the document id, so it has to be free of slashes; it
 * also has to be long enough that two unrelated orders cannot collide.
 *
 * @param {string} raw Key as the client sent it.
 * @return {string} The validated key.
 */
export function validateIdempotencyKey(raw: string): string {
  const key = String(raw ?? "").trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "idempotencyKey",
      "idempotencyKey は英数字・ハイフン・アンダースコアの8〜64文字です。",
    );
  }
  return key;
}

/** Fields common to every order kind. */
interface OpenOrderBase {
  uid: string;
  idempotencyKey: string;
  domainName: string;
  registry: RegistryId;
  periodYears: number;
  priceYen: number;
}

/** Everything needed to open an order. */
export type OpenOrderInput =
  | (OpenOrderBase & {
      kind: "create";
      nameservers: string[];
      authInfo: string;
      /** Auto-renew choice from the form; omitted means ON (§6.2.6). */
      autoRenew?: boolean;
    })
  | (OpenOrderBase & {
      kind: "renew";
      curExpDate: string;
      expectedExDate: string;
    });

/**
 * Returns the order for this idempotency key, creating it when it is new.
 *
 * The pseudo-payment is considered settled at creation time, so a brand new
 * order starts in `paid` (FIG.1).
 *
 * @param {OpenOrderInput} input Order parameters.
 * @return {Promise<OrderHandle>} The order and whether we just created it.
 */
export async function openOrder(
  input: OpenOrderInput,
): Promise<OrderHandle> {
  const id = `${input.uid}__${input.idempotencyKey}`;
  const ref = db().collection(COLLECTIONS.orders).doc(id);

  const existing = await ref.get();
  if (existing.exists) {
    return {id, ref, data: existing.data() as OrderDoc, isNew: false};
  }

  const seq = await nextSequence("orders");
  const doc: OrderDoc = input.kind === "create" ?
    {
      uid: input.uid,
      seq,
      kind: "create",
      domainName: input.domainName,
      registry: input.registry,
      periodYears: input.periodYears,
      nameservers: input.nameservers,
      priceYen: input.priceYen,
      state: "paid",
      attempts: 0,
      idempotencyKey: input.idempotencyKey,
      authInfo: input.authInfo,
      autoRenew: input.autoRenew ?? true,
    } :
    {
      uid: input.uid,
      seq,
      kind: "renew",
      domainName: input.domainName,
      registry: input.registry,
      periodYears: input.periodYears,
      nameservers: [],
      priceYen: input.priceYen,
      state: "paid",
      attempts: 0,
      idempotencyKey: input.idempotencyKey,
      curExpDate: input.curExpDate,
      expectedExDate: input.expectedExDate,
    };

  try {
    await ref.create({
      ...doc,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {id, ref, data: doc, isNew: true};
  } catch {
    // Lost a race against a concurrent identical submit: the other request
    // won, so adopt its order rather than charging twice.
    const raced = await ref.get();
    return {id, ref, data: raced.data() as OrderDoc, isNew: false};
  }
}

/**
 * Writes a state transition and any accompanying fields.
 *
 * @param {OrderHandle} order Order being moved.
 * @param {OrderState} state New state.
 * @param {Partial<OrderDoc>} patch Extra fields to persist.
 * @return {Promise<void>} Resolves once written.
 */
export async function transitionOrder(
  order: OrderHandle,
  state: OrderState,
  patch: Partial<OrderDoc> = {},
): Promise<void> {
  order.data = {...order.data, ...patch, state};
  await order.ref.set(
    {...patch, state, updatedAt: FieldValue.serverTimestamp()},
    {merge: true},
  );
}

/**
 * Increments the attempt counter used by the retry limit.
 *
 * @param {OrderHandle} order Order being retried.
 * @return {Promise<number>} The new attempt number.
 */
export async function bumpAttempts(order: OrderHandle): Promise<number> {
  const attempts = (order.data.attempts ?? 0) + 1;
  order.data.attempts = attempts;
  await order.ref.set(
    {attempts, updatedAt: FieldValue.serverTimestamp()},
    {merge: true},
  );
  return attempts;
}

/**
 * Whether an order has already reached a state where nothing more happens.
 *
 * @param {OrderDoc} order Order to inspect.
 * @return {boolean} True when done or failed.
 */
export function isTerminal(order: OrderDoc): boolean {
  return TERMINAL_STATES.includes(order.state);
}

/**
 * Points every unfinished order for one domain at the registry that really
 * holds it.
 *
 * A registry-side TLD migration leaves both mirrors stale at once: the
 * `domains` record and any order still in flight for that domain. Healing only
 * the domain would swap one inconsistency for another — `renewDomain`'s lease
 * transaction refuses to run when `domain.registry !== order.registry` and
 * fails the order with an internal error — so the two are always healed
 * together (see `confirmGoneAcrossRegistries`).
 *
 * Terminal orders are left exactly as they were: `done` and `failed` are the
 * historical record of what was sent to which registry at the time, and
 * rewriting that would falsify the audit trail without helping anyone.
 *
 * @param {string} uid Owner of the orders.
 * @param {string} domainName Domain the orders are for.
 * @param {RegistryId} registry Registry the domain actually lives at.
 * @return {Promise<number>} How many orders were re-pointed.
 */
export async function retargetOpenOrders(
  uid: string,
  domainName: string,
  registry: RegistryId,
): Promise<number> {
  const found = await db()
    .collection(COLLECTIONS.orders)
    .where("uid", "==", uid)
    .where("domainName", "==", domainName)
    .get();

  const stale = found.docs.filter((doc) => {
    const data = doc.data() as OrderDoc;
    return !isTerminal(data) && data.registry !== registry;
  });

  await Promise.all(stale.map((doc) =>
    doc.ref.set(
      {registry, updatedAt: FieldValue.serverTimestamp()},
      {merge: true},
    )));

  return stale.length;
}
