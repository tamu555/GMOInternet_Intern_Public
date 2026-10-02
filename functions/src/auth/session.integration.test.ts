/**
 * End-to-end HTTP integration tests for the session surface:
 * `issueCsrfToken` -> `sessionLogin` -> `sessionMe` -> `sessionLogout`.
 *
 * These are `onRequest` handlers (not `onCall`), so they are exercised over
 * plain HTTP against the Functions Emulator, the same style as the
 * `sessionLogin`/`sessionLogout` coverage in `auth.integration.test.ts`.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {afterEach, before, describe, it} from "node:test";

import {Timestamp} from "firebase-admin/firestore";

import {adminAuth as auth} from "../config/firebase.js";
import {REGION} from "../config/options.js";
import {
  AUTH_PROVIDER,
  SESSION_COOKIE_NAME,
  USER_STATUS,
} from "./constants.js";
import {userDocument} from "./firestore.js";
import type {UserDocument} from "./types.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? "teamc-2026";
const AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const FUNCTIONS_EMULATOR_HOST =
  process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5001";
const AUTH_API_BASE =
  `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const FUNCTIONS_API_BASE =
  `http://${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/${REGION}`;
const API_KEY = "fake-api-key";
const TEST_PASSWORD = "SessionIntegration123!";

const FIXTURE_JAPAN_ADDRESS = {
  addressLine: "1-1-1",
  building: null,
  city: "千代田区",
  country: "JP" as const,
  postalCode: "123-4567",
  prefecture: "東京都",
};

const FIXTURE_PROFILE = {
  accountType: "individual" as const,
  address: FIXTURE_JAPAN_ADDRESS,
  business: null,
  dateOfBirth: "1990-01-01",
  gender: "no_answer" as const,
  name: "Session Integration User",
  nameKana: "セッションインテグレーションユーザー",
  newsletterOptIn: false,
  phoneNumber: "090-1234-5678",
};

const fixtureUserIds = new Set<string>();

/**
 * Creates an isolated email address for one test fixture.
 *
 * @return {string} Unique email address.
 */
function uniqueEmail(): string {
  return `session-integration-${randomUUID()}@example.com`;
}

interface AuthRestPayload {
  idToken?: unknown;
  localId?: unknown;
}

/**
 * Signs in an Auth Emulator password user and returns its ID token.
 *
 * @param {string} email Fixture email.
 * @return {Promise<object>} Signed-in identity (idToken, uid).
 */
async function signInWithPassword(
  email: string,
): Promise<{idToken: string; uid: string}> {
  const response = await fetch(
    `${AUTH_API_BASE}/accounts:signInWithPassword?key=${API_KEY}`,
    {
      body: JSON.stringify({
        email,
        password: TEST_PASSWORD,
        returnSecureToken: true,
      }),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    },
  );
  const payload = await response.json() as AuthRestPayload;
  assert.equal(response.ok, true, JSON.stringify(payload));
  assert.equal(typeof payload.idToken, "string");
  assert.equal(typeof payload.localId, "string");
  return {
    idToken: payload.idToken as string,
    uid: payload.localId as string,
  };
}

/**
 * Creates an Auth user and a matching active `users/{uid}` fixture document.
 *
 * @return {Promise<object>} Fixture identifiers (email, uid).
 */
async function seedActiveUser(): Promise<{email: string; uid: string}> {
  const email = uniqueEmail();
  const user = await auth().createUser({email, password: TEST_PASSWORD});
  fixtureUserIds.add(user.uid);
  const now = Timestamp.now();
  const document: UserDocument = {
    authProvider: AUTH_PROVIDER.PASSWORD,
    createdAt: now,
    deletionRequestedAt: null,
    email,
    profile: FIXTURE_PROFILE,
    purgeTaskName: null,
    scheduledPurgeAt: null,
    status: USER_STATUS.ACTIVE,
    uid: user.uid,
    updatedAt: now,
  };
  await userDocument(user.uid).set(document);
  return {email, uid: user.uid};
}

/**
 * Calls `issueCsrfToken` and returns the parsed token.
 *
 * @return {Promise<object>} Response and parsed token, if present.
 */
async function callIssueCsrfToken(
): Promise<{response: Response; csrfToken: string | undefined}> {
  const response = await fetch(`${FUNCTIONS_API_BASE}/issueCsrfToken`, {
    method: "GET",
  });
  const payload = await response.json() as {csrfToken?: unknown};
  return {
    csrfToken: typeof payload.csrfToken === "string" ?
      payload.csrfToken :
      undefined,
    response,
  };
}

/**
 * Calls `sessionLogin` with the contract's JSON and CSRF headers.
 *
 * @param {string} idToken Firebase ID token.
 * @param {string|null} headerCsrfToken Header token, or null to omit it.
 * @param {string} bodyCsrfToken Body token.
 * @return {Promise<Response>} HTTP response.
 */
async function callSessionLogin(
  idToken: string,
  headerCsrfToken: string | null,
  bodyCsrfToken: string,
): Promise<Response> {
  const headers: Record<string, string> = {"Content-Type": "application/json"};
  if (headerCsrfToken !== null) {
    headers["X-CSRF-Token"] = headerCsrfToken;
  }
  return await fetch(`${FUNCTIONS_API_BASE}/sessionLogin`, {
    body: JSON.stringify({csrfToken: bodyCsrfToken, idToken}),
    headers,
    method: "POST",
  });
}

/**
 * Calls `sessionMe` with an optional session cookie.
 *
 * @param {string|undefined} sessionCookie Decoded Firebase session cookie.
 * @return {Promise<Response>} HTTP response.
 */
async function callSessionMe(sessionCookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (sessionCookie !== undefined) {
    headers.Cookie = `${SESSION_COOKIE_NAME}=${sessionCookie}`;
  }
  return await fetch(`${FUNCTIONS_API_BASE}/sessionMe`, {
    headers,
    method: "GET",
  });
}

/**
 * Calls `sessionLogout` with a session cookie and the contract's CSRF
 * double-submit header/body, matching `sessionLogin`'s pattern.
 *
 * @param {string} sessionCookie Decoded Firebase session cookie.
 * @param {string|null} headerCsrfToken Header token, or null to omit it.
 * @param {string} bodyCsrfToken Body token.
 * @return {Promise<Response>} HTTP response.
 */
async function callSessionLogout(
  sessionCookie: string,
  headerCsrfToken: string | null,
  bodyCsrfToken: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
  };
  if (headerCsrfToken !== null) {
    headers["X-CSRF-Token"] = headerCsrfToken;
  }
  return await fetch(`${FUNCTIONS_API_BASE}/sessionLogout`, {
    body: JSON.stringify({csrfToken: bodyCsrfToken}),
    headers,
    method: "POST",
  });
}

/**
 * Extracts and decodes the session cookie value from Set-Cookie.
 *
 * @param {Response} response Login response.
 * @return {string} Decoded Firebase session cookie.
 */
function readIssuedSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const match = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+);`).exec(setCookie);
  assert.ok(match);
  assert.notEqual(match[1], "");
  return decodeURIComponent(match[1]);
}

/**
 * Checks whether an error is the expected cleanup user-not-found result.
 *
 * @param {unknown} error Thrown Auth SDK value.
 * @return {boolean} Whether this is auth/user-not-found.
 */
function isUserNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as {code?: unknown}).code === "auth/user-not-found";
}

before(() => {
  assert.ok(
    process.env.FIREBASE_AUTH_EMULATOR_HOST,
    "FIREBASE_AUTH_EMULATOR_HOST must be set by emulators:exec",
  );
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "FIRESTORE_EMULATOR_HOST must be set by emulators:exec",
  );
});

afterEach(async () => {
  for (const uid of fixtureUserIds) {
    await userDocument(uid).delete();
    try {
      await auth().deleteUser(uid);
    } catch (error: unknown) {
      if (!isUserNotFound(error)) {
        throw error;
      }
    }
  }
  fixtureUserIds.clear();
});

describe("issueCsrfToken", () => {
  it("issues a non-empty token", async () => {
    const {csrfToken, response} = await callIssueCsrfToken();
    assert.equal(response.status, 200);
    assert.equal(typeof csrfToken, "string");
    assert.notEqual(csrfToken, "");
  });

  it("issues a fresh, unpredictable token on each call", async () => {
    const first = await callIssueCsrfToken();
    const second = await callIssueCsrfToken();
    assert.notEqual(first.csrfToken, second.csrfToken);
  });

  it("rejects non-GET methods", async () => {
    const response = await fetch(`${FUNCTIONS_API_BASE}/issueCsrfToken`, {
      method: "POST",
    });
    assert.equal(response.status, 405);
  });
});

describe("full session round trip", () => {
  it("issues the CSRF token, logs in, reads sessionMe, then logs out",
    async () => {
      const fixture = await seedActiveUser();
      const {idToken} = await signInWithPassword(fixture.email);
      const {csrfToken} = await callIssueCsrfToken();
      assert.equal(typeof csrfToken, "string");
      if (typeof csrfToken !== "string") {
        return;
      }

      const loginResponse = await callSessionLogin(
        idToken,
        csrfToken,
        csrfToken,
      );
      assert.equal(loginResponse.status, 200);
      assert.deepEqual(await loginResponse.json(), {status: "ok"});
      const sessionCookie = readIssuedSessionCookie(loginResponse);

      const meResponse = await callSessionMe(sessionCookie);
      assert.equal(meResponse.status, 200);
      assert.deepEqual(await meResponse.json(), {
        displayName: FIXTURE_PROFILE.name,
        email: fixture.email,
        id: fixture.uid,
      });

      // Firebase's revoked-tokens check has one-second granularity: revoking
      // in the same second the session cookie was issued can leave a
      // just-revoked cookie appearing valid (see the identical wait in
      // auth.integration.test.ts's "revokes a valid session" case).
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const {csrfToken: logoutCsrfToken} = await callIssueCsrfToken();
      assert.equal(typeof logoutCsrfToken, "string");
      if (typeof logoutCsrfToken !== "string") {
        return;
      }
      const logoutResponse = await callSessionLogout(
        sessionCookie,
        logoutCsrfToken,
        logoutCsrfToken,
      );
      assert.equal(logoutResponse.status, 200);
      assert.deepEqual(await logoutResponse.json(), {status: "ok"});

      const meAfterLogout = await callSessionMe(sessionCookie);
      assert.equal(meAfterLogout.status, 401);
    });

  it("rejects sessionMe without a session cookie", async () => {
    const response = await callSessionMe();
    assert.equal(response.status, 401);
  });

  it("rejects sessionMe with an invalid session cookie", async () => {
    const response = await callSessionMe("not-a-real-session-cookie");
    assert.equal(response.status, 401);
  });

  it("rejects sessionLogin missing the X-CSRF-Token header even with a " +
    "freshly issued token", async () => {
    const fixture = await seedActiveUser();
    const {idToken} = await signInWithPassword(fixture.email);
    const {csrfToken} = await callIssueCsrfToken();
    assert.equal(typeof csrfToken, "string");
    if (typeof csrfToken !== "string") {
      return;
    }

    const response = await callSessionLogin(idToken, null, csrfToken);
    assert.equal(response.status, 403);
  });

  it("rejects sessionLogin when the header and body CSRF tokens mismatch " +
    "(both drawn from real issueCsrfToken calls)", async () => {
    const fixture = await seedActiveUser();
    const {idToken} = await signInWithPassword(fixture.email);
    const first = await callIssueCsrfToken();
    const second = await callIssueCsrfToken();
    assert.equal(typeof first.csrfToken, "string");
    assert.equal(typeof second.csrfToken, "string");
    if (
      typeof first.csrfToken !== "string" ||
      typeof second.csrfToken !== "string"
    ) {
      return;
    }

    const response = await callSessionLogin(
      idToken,
      first.csrfToken,
      second.csrfToken,
    );
    assert.equal(response.status, 403);
  });

  it("rejects sessionLogout missing the X-CSRF-Token header, without " +
    "touching the session cookie", async () => {
    const fixture = await seedActiveUser();
    const {idToken} = await signInWithPassword(fixture.email);
    const {csrfToken} = await callIssueCsrfToken();
    assert.equal(typeof csrfToken, "string");
    if (typeof csrfToken !== "string") {
      return;
    }
    const loginResponse = await callSessionLogin(idToken, csrfToken, csrfToken);
    assert.equal(loginResponse.status, 200);
    const sessionCookie = readIssuedSessionCookie(loginResponse);

    const {csrfToken: logoutCsrfToken} = await callIssueCsrfToken();
    assert.equal(typeof logoutCsrfToken, "string");
    if (typeof logoutCsrfToken !== "string") {
      return;
    }
    const response = await callSessionLogout(
      sessionCookie,
      null,
      logoutCsrfToken,
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);

    // The session must still be valid: the rejected logout must not have
    // revoked it.
    const meResponse = await callSessionMe(sessionCookie);
    assert.equal(meResponse.status, 200);
  });

  it("rejects sessionLogout when the header and body CSRF tokens " +
    "mismatch (both drawn from real issueCsrfToken calls), without " +
    "touching the session cookie", async () => {
    const fixture = await seedActiveUser();
    const {idToken} = await signInWithPassword(fixture.email);
    const {csrfToken} = await callIssueCsrfToken();
    assert.equal(typeof csrfToken, "string");
    if (typeof csrfToken !== "string") {
      return;
    }
    const loginResponse = await callSessionLogin(idToken, csrfToken, csrfToken);
    assert.equal(loginResponse.status, 200);
    const sessionCookie = readIssuedSessionCookie(loginResponse);

    const first = await callIssueCsrfToken();
    const second = await callIssueCsrfToken();
    assert.equal(typeof first.csrfToken, "string");
    assert.equal(typeof second.csrfToken, "string");
    if (
      typeof first.csrfToken !== "string" ||
      typeof second.csrfToken !== "string"
    ) {
      return;
    }
    const response = await callSessionLogout(
      sessionCookie,
      first.csrfToken,
      second.csrfToken,
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);

    const meResponse = await callSessionMe(sessionCookie);
    assert.equal(meResponse.status, 200);
  });

  it("accepts a stale-but-valid csrfToken from an earlier issueCsrfToken " +
    "call paired with a currently-valid idToken (tokens are not " +
    "server-side tracked or single-use, by design)", async () => {
    const fixture = await seedActiveUser();

    // The csrfToken is minted well before it is used below; nothing in
    // this design invalidates it with age or a prior use, since
    // sessionLogin's actual protection is the {cors:false} same-origin
    // restriction, not the token's freshness (architecture doc §1.2).
    const {csrfToken: staleCsrfToken} = await callIssueCsrfToken();
    assert.equal(typeof staleCsrfToken, "string");
    if (typeof staleCsrfToken !== "string") {
      return;
    }
    // Simulate time passing and the token having already been "seen"
    // once before, by issuing (and discarding) a second token in between.
    await callIssueCsrfToken();

    const {idToken} = await signInWithPassword(fixture.email);
    const response = await callSessionLogin(
      idToken,
      staleCsrfToken,
      staleCsrfToken,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {status: "ok"});
  });
});
