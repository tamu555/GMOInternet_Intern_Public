/**
 * Callable-contract tests for `getOrder`. Every dependency is substituted,
 * so these run without Firestore or a registry. Covered: auth, id
 * validation ahead of any load, the uniform not-found for missing/foreign
 * orders, resume-on-non-terminal (and never on terminal), and the wire
 * serialization the deleted stub established.
 */
import assert from "node:assert/strict";
import {describe, it} from "node:test";

import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";
import type {DocumentReference} from "firebase-admin/firestore";

import type {OrderDoc, OrderHandle} from "../domain/orders";
import {handleGetOrder, serializeOrder} from "./getOrder";
import type {GetOrderDependencies} from "./getOrder";

const UID = "member-uid-1";
const ORDER_ID = `${UID}__abcdef1234567890`;

/**
 * Builds an OrderDoc fixture.
 *
 * @param {Partial<OrderDoc>} overrides Field overrides.
 * @return {OrderDoc} A create-kind order in `retrying` by default.
 */
function orderDoc(overrides: Partial<OrderDoc> = {}): OrderDoc {
  return {
    uid: UID,
    seq: 1,
    kind: "create",
    domainName: "example.com",
    registry: "kitaqnic",
    periodYears: 2,
    nameservers: ["ns1.example.net"],
    priceYen: 3000,
    state: "retrying",
    attempts: 1,
    idempotencyKey: "abcdef1234567890",
    authInfo: "OrderAuth1234567890!",
    autoRenew: false,
    ...overrides,
  };
}

/**
 * Wraps an OrderDoc as the handle the loader would return.
 *
 * @param {OrderDoc} data Order document.
 * @return {OrderHandle} Handle with a dummy ref (never touched in tests).
 */
function orderHandle(data: OrderDoc): OrderHandle {
  return {
    id: ORDER_ID,
    ref: {} as DocumentReference,
    data,
    isNew: false,
  };
}

/**
 * Builds the request shape received after Callable authentication.
 *
 * @param {T} data Callable request data.
 * @param {string} uid Authenticated fixture UID, omitted for the
 *   unauthenticated case.
 * @return {CallableRequest<T>} Synthetic Callable request.
 */
function callableRequest<T>(data: T, uid?: string): CallableRequest<T> {
  const base = {
    acceptsStreaming: false,
    data,
    rawRequest: {},
  } as CallableRequest<T>;
  if (uid === undefined) return base;
  return {
    ...base,
    auth: {
      uid,
      token: {uid, sub: uid, auth_time: Math.floor(Date.now() / 1000)},
      rawToken: "test-token",
    },
  } as CallableRequest<T>;
}

/**
 * Asserts that a Callable rejects with the given HttpsError contract.
 *
 * @param {Function} action Callable invocation.
 * @param {object} expected Expected code and optional message.
 * @return {Promise<void>} Resolves when the rejection matched.
 */
async function assertRejectsWith(
  action: () => Promise<unknown>,
  expected: {code: string; message?: string},
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof HttpsError, "expected an HttpsError");
    assert.equal((error as HttpsError).code, expected.code);
    if (expected.message !== undefined) {
      assert.equal((error as HttpsError).message, expected.message);
    }
    return true;
  });
}

/**
 * Builds recording fake dependencies around one stored order.
 *
 * @param {OrderHandle | null} order What the loader answers.
 * @param {Function} onResume Optional resume behaviour (e.g. mutate state).
 * @return {{deps: GetOrderDependencies, calls: {loads: string[],
 *   resumes: number}}} Fakes plus their call log.
 */
function fakeDependencies(
  order: OrderHandle | null,
  onResume?: (order: OrderHandle) => void,
): {deps: GetOrderDependencies; calls: {loads: string[]; resumes: number}} {
  const calls = {loads: [] as string[], resumes: 0};
  const deps: GetOrderDependencies = {
    loadOwnOrder: async (uid, orderId) => {
      calls.loads.push(`${uid}/${orderId}`);
      return order;
    },
    resumeOrder: async (handle) => {
      calls.resumes += 1;
      onResume?.(handle);
    },
  };
  return {deps, calls};
}

describe("handleGetOrder", () => {
  it("rejects unauthenticated calls", async () => {
    const {deps} = fakeDependencies(null);
    await assertRejectsWith(
      () => handleGetOrder(callableRequest({orderId: ORDER_ID}), deps),
      {code: "unauthenticated"},
    );
  });

  it("rejects a malformed orderId before any load", async () => {
    const {deps, calls} = fakeDependencies(null);
    await assertRejectsWith(
      () => handleGetOrder(callableRequest({orderId: 42}, UID), deps),
      {code: "invalid-argument"},
    );
    await assertRejectsWith(
      () => handleGetOrder(callableRequest({orderId: "a/b"}, UID), deps),
      {code: "invalid-argument"},
    );
    assert.equal(calls.loads.length, 0);
  });

  it("answers a uniform not-found for missing or foreign orders", async () => {
    const {deps} = fakeDependencies(null);
    await assertRejectsWith(
      () => handleGetOrder(callableRequest({orderId: ORDER_ID}, UID), deps),
      {code: "not-found", message: "対象の注文が見つかりません。"},
    );
  });

  it("does NOT resume a terminal order", async () => {
    const {deps, calls} = fakeDependencies(
      orderHandle(orderDoc({
        state: "done",
        result: {crDate: "2026-08-26", exDate: "2028-08-26", recovered: false},
      })),
    );
    const result = await handleGetOrder(
      callableRequest({orderId: ORDER_ID}, UID),
      deps,
    );
    assert.equal(calls.resumes, 0);
    assert.equal(result.state, "done");
  });

  it("resumes a non-terminal order and serializes the advanced state",
    async () => {
      const {deps, calls} = fakeDependencies(
        orderHandle(orderDoc({state: "retrying"})),
        (handle) => {
          handle.data = {
            ...handle.data,
            state: "done",
            result: {exDate: "2028-08-26", recovered: false},
          };
        },
      );
      const result = await handleGetOrder(
        callableRequest({orderId: ORDER_ID}, UID),
        deps,
      );
      assert.equal(calls.resumes, 1);
      assert.equal(result.state, "done");
      assert.equal(result.domain?.exDate, "2028-08-26");
    });
});

describe("serializeOrder", () => {
  it("projects a done create order, authInfo and NS statuses included", () => {
    const result = serializeOrder(ORDER_ID, orderDoc({
      state: "done",
      result: {crDate: "2026-08-26", exDate: "2028-08-26", recovered: true},
    }));
    assert.deepEqual(result, {
      id: ORDER_ID,
      kind: "create",
      domainName: "example.com",
      state: "done",
      years: 2,
      autoRenew: false,
      priceYen: 3000,
      domain: {
        name: "example.com",
        statuses: ["ok"],
        exDate: "2028-08-26",
        authInfo: "OrderAuth1234567890!",
      },
    });
  });

  it("marks a done create order without nameservers as inactive", () => {
    const result = serializeOrder(ORDER_ID, orderDoc({
      state: "done",
      nameservers: [],
      result: {exDate: "2028-08-26", recovered: false},
    }));
    assert.deepEqual(result.domain?.statuses, ["inactive"]);
  });

  it("surfaces the EPP result code of a failed order", () => {
    const result = serializeOrder(ORDER_ID, orderDoc({
      state: "failed",
      error: {kind: "policyViolation", resultCode: 2306},
    }));
    assert.equal(result.resultCode, 2306);
    assert.equal(result.domain, undefined);
  });

  it("treats a renew order as flagless and authInfo-less", () => {
    const result = serializeOrder(ORDER_ID, orderDoc({
      kind: "renew",
      authInfo: undefined,
      autoRenew: undefined,
      state: "done",
      result: {exDate: "2029-08-26", recovered: false},
    }));
    assert.equal(result.autoRenew, false);
    assert.deepEqual(result.domain, {
      name: "example.com",
      statuses: ["ok"],
      exDate: "2029-08-26",
      authInfo: "",
    });
  });

  it("defaults a legacy create order (no stored flag) to autoRenew ON",
    () => {
      const result = serializeOrder(ORDER_ID, orderDoc({
        autoRenew: undefined,
      }));
      assert.equal(result.autoRenew, true);
      assert.equal(result.state, "retrying");
    });
});
