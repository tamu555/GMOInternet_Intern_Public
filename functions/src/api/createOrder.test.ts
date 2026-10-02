import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {afterEach, before, describe, it, mock} from "node:test";

import {FieldValue, Timestamp} from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import type {CallableRequest} from "firebase-functions/v2/https";

import {AUTH_PROVIDER, USER_STATUS} from "../auth/constants";
import {userDocument} from "../auth/firestore";
import type {ActiveUser} from "../auth/types";
import {EppClient, type EppRequest, type EppSuccess} from "../bridge/eppClient";
import {EPP_RESULT} from "../bridge/types";
import type {RegistryId} from "../config/options";
import {COLLECTIONS, db} from "../config/firebase";
import {resetTldCache} from "../bridge/registryRouter";
import {createOrder} from "./createOrder";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "teamc-2026";
const REGISTRY: RegistryId = "kitaqsign";

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST is required for these tests.",
  );
});

afterEach(() => {
  mock.restoreAll();
});

const functionsTest = firebaseFunctionsTest({projectId: PROJECT_ID});
const wrappedCreateOrder = functionsTest.wrap(createOrder);

/**
 * Builds the request shape received after Callable authentication succeeds.
 *
 * @param {string | undefined} uid Authenticated fixture UID, or undefined for
 *   an unauthenticated call.
 * @param {unknown} data Callable request data.
 * @return {CallableRequest<unknown>} Synthetic Callable request.
 */
function callableRequest(
  uid: string | undefined,
  data: unknown = {},
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ?
      {uid, token: {uid, sub: uid, auth_time: Math.floor(Date.now() / 1000)}} :
      undefined,
    acceptsStreaming: false,
    rawRequest: {},
  } as CallableRequest<unknown>;
}

/**
 * Asserts that a Callable rejects with one stable Functions error code.
 *
 * @param {Function} action Callable invocation.
 * @param {string} expectedCode Expected HttpsError code.
 * @return {Promise<void>} Resolves after the rejection is verified.
 */
async function assertRejectsWithCode(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal((error as {code?: unknown}).code, expectedCode);
    return true;
  });
}

/**
 * Builds a successful `session:hello` EppSuccess envelope, reporting `.com`
 * as a served TLD so TLD routing resolves to {@link REGISTRY} without
 * falling back to the static map.
 *
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function helloSuccess(): EppSuccess<unknown> {
  return {
    httpStatus: 200,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {registryCode: "TEST", tlds: ["com"], message: "hello"},
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-HELLO",
    tolerated: false,
  };
}

/**
 * Builds a successful `contact:create` EppSuccess envelope.
 *
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function contactCreateSuccess(): EppSuccess<unknown> {
  return {
    httpStatus: 201,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {},
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-CONTACT",
    tolerated: false,
  };
}

/**
 * Builds a successful `domain:create` EppSuccess envelope.
 *
 * @param {string} domain Domain name echoed back.
 * @param {string} crDate Creation date to answer with.
 * @param {string} exDate Expiry to answer with.
 * @return {EppSuccess<unknown>} A stubbed success envelope.
 */
function domainCreateSuccess(
  domain: string,
  crDate: string,
  exDate: string,
): EppSuccess<unknown> {
  return {
    httpStatus: 201,
    resultCode: EPP_RESULT.SUCCESS,
    resData: {domain, crDate, exDate},
    extension: undefined,
    clTRID: "stub",
    svTRID: "SV-CREATE",
    tolerated: false,
  };
}

/** Per-command async response handlers for {@link stubSend}. */
interface SendHandlers {
  "session:hello"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
  "contact:create"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
  "domain:create"?: (request: EppRequest) => Promise<EppSuccess<unknown>>;
}

/**
 * Stubs `EppClient.prototype.send`, dispatching on `request.command`.
 *
 * @param {SendHandlers} handlers Per-command async handlers.
 * @return {object} The installed mock, for inspecting `.mock.calls`.
 */
function stubSend(handlers: SendHandlers) {
  return mock.method(
    EppClient.prototype,
    "send",
    async (request: EppRequest) => {
      const command = request.command as keyof SendHandlers;
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`unexpected command in test stub: ${command}`);
      }
      return handler(request);
    },
  );
}

/** Minimal but complete profile for a seeded active member fixture. */
const FIXTURE_PROFILE: ActiveUser["profile"] = {
  accountType: "individual",
  address: {
    addressLine: "1-1-1",
    building: null,
    city: "千代田区",
    country: "JP",
    postalCode: "100-0001",
    prefecture: "東京都",
  },
  business: null,
  dateOfBirth: "1990-01-01",
  gender: "no_answer",
  name: "Test Member",
  nameKana: "テストメンバー",
  newsletterOptIn: false,
  phoneNumber: "090-0000-0000",
};

/**
 * Writes an active users/{uid} document, so the caller clears
 * `requireActiveUser` (src/auth/callerGuard.ts).
 *
 * @param {string} uid Fixture uid.
 * @return {Promise<void>} Resolves once the document is written.
 */
async function seedActiveUser(uid: string): Promise<void> {
  const now = Timestamp.now();
  const user: ActiveUser = {
    authProvider: AUTH_PROVIDER.PASSWORD,
    createdAt: now,
    deletionRequestedAt: null,
    email: `${uid}@example.com`,
    profile: FIXTURE_PROFILE,
    purgeTaskName: null,
    scheduledPurgeAt: null,
    status: USER_STATUS.ACTIVE,
    uid,
    updatedAt: now,
  };
  await userDocument(uid).set(user);
}

interface OrderFixture {
  uid: string;
  domainName: string;
  idempotencyKey: string;
}

/**
 * Builds unique uid/domainName/idempotencyKey identifiers for one test, and
 * seeds an active user document for the uid.
 *
 * @return {Promise<OrderFixture>} Fresh, unique identifiers.
 */
async function makeFixture(): Promise<OrderFixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const fixture = {
    uid: `uid-${suffix}`,
    domainName: `create-${suffix}.com`,
    idempotencyKey: `key-${suffix}`,
  };
  await seedActiveUser(fixture.uid);
  return fixture;
}

// --- createOrder regression tests --------------------------------------------
//
// createOrder.ts was touched by the renew feature's OrderDoc/OpenOrderInput
// discriminated-union migration (kind: "create" explicit tag + a kind-
// collision guard). These tests prove the existing create-order behavior is
// unchanged.

describe("createOrder — auth", () => {
  it("rejects a signed-in caller with no user document", async () => {
    // Regression for requireActiveUser (src/auth/callerGuard.ts): a valid
    // ID token alone — mintable straight against Identity Toolkit's public
    // accounts:signUp — must not be enough to reach this Callable.
    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    await assertRejectsWithCode(
      () =>
        wrappedCreateOrder(callableRequest(`uid-${suffix}`, {
          domainName: `no-user-doc-${suffix}.com`,
          periodYears: 1,
          idempotencyKey: `key-${suffix}`,
        })),
      "permission-denied",
    );
  });
});

describe("createOrder — happy path", () => {
  it("opens a create order, storing kind: \"create\" and the create shape",
    async () => {
      resetTldCache();
      const fixture = await makeFixture();
      const send = stubSend({
        "session:hello": async () => helloSuccess(),
        "contact:create": async () => contactCreateSuccess(),
        "domain:create": async () =>
          domainCreateSuccess(fixture.domainName, "2026-08-25", "2027-08-25"),
      });

      const result = await wrappedCreateOrder(callableRequest(fixture.uid, {
        domainName: fixture.domainName,
        periodYears: 1,
        idempotencyKey: fixture.idempotencyKey,
      })) as {orderId: string; state: string};

      assert.equal(result.state, "done");

      const orderSnap = await db()
        .collection(COLLECTIONS.orders)
        .doc(`${fixture.uid}__${fixture.idempotencyKey}`)
        .get();
      assert.equal(orderSnap.data()?.kind, "create");
      assert.equal(orderSnap.data()?.domainName, fixture.domainName);
      assert.equal(orderSnap.data()?.state, "done");
      assert.deepEqual(orderSnap.data()?.nameservers, []);
      assert.equal(typeof orderSnap.data()?.authInfo, "string");
      assert.equal(orderSnap.data()?.curExpDate, undefined);
      assert.equal(orderSnap.data()?.expectedExDate, undefined);

      assert.ok(
        send.mock.calls.some((c) => c.arguments[0].command === "domain:create"),
      );
    });
});

describe("createOrder — idempotency and kind collision", () => {
  it("reuses the existing order for a repeat key without re-charging or " +
    "issuing another registry command", async () => {
    resetTldCache();
    const fixture = await makeFixture();
    stubSend({
      "session:hello": async () => helloSuccess(),
      "contact:create": async () => contactCreateSuccess(),
      "domain:create": async () =>
        domainCreateSuccess(fixture.domainName, "2026-08-25", "2027-08-25"),
    });

    const first = await wrappedCreateOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: fixture.idempotencyKey,
    })) as {orderId: string; state: string};
    assert.equal(first.state, "done");

    mock.restoreAll();
    const send = stubSend({});
    const second = await wrappedCreateOrder(callableRequest(fixture.uid, {
      domainName: fixture.domainName,
      periodYears: 1,
      idempotencyKey: fixture.idempotencyKey,
    })) as {orderId: string; state: string};

    assert.equal(second.orderId, first.orderId);
    assert.equal(second.state, "done");
    assert.equal(send.mock.calls.length, 0);
  });

  it("rejects reusing an idempotency key already used by a renew order",
    async () => {
      const fixture = await makeFixture();
      await db()
        .collection(COLLECTIONS.orders)
        .doc(`${fixture.uid}__${fixture.idempotencyKey}`)
        .set({
          uid: fixture.uid,
          seq: 1,
          kind: "renew",
          domainName: fixture.domainName,
          registry: REGISTRY,
          periodYears: 1,
          nameservers: [],
          priceYen: 1500,
          state: "done",
          attempts: 1,
          idempotencyKey: fixture.idempotencyKey,
          curExpDate: "2027-05-05",
          expectedExDate: "2028-05-05",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

      await assertRejectsWithCode(
        () =>
          wrappedCreateOrder(callableRequest(fixture.uid, {
            domainName: fixture.domainName,
            periodYears: 1,
            idempotencyKey: fixture.idempotencyKey,
          })),
        "invalid-argument",
      );
    });
});
