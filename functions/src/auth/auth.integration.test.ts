import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {after, afterEach, before, describe, it} from "node:test";

import type {UserRecord} from "firebase-admin/auth";
import {Timestamp} from "firebase-admin/firestore";
import firebaseFunctionsTest from "firebase-functions-test";
import type {CallableRequest} from "firebase-functions/v2/https";
import {HttpsError} from "firebase-functions/v2/https";

import {adminAuth as auth} from "../config/firebase.js";
import {REGION} from "../config/options.js";
import {
  AUTH_PROVIDER,
  MILLISECONDS_PER_DAY,
  SESSION_COOKIE_EXPIRES_IN_MS,
  SESSION_COOKIE_NAME,
  USER_STATUS,
  VERIFICATION_CODE_TTL_MS,
  VERIFICATION_GRANT_TTL_MS,
  VERIFICATION_MAX_ATTEMPTS,
} from "./constants.js";
import {userDocument, verificationDocument} from "./firestore.js";
import {registerWithEmailPassword} from "./registration.js";
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
const TEST_PASSWORD = "Integration123!";
const CSRF_TOKEN = "integration-csrf-token";

const FIXTURE_JAPAN_ADDRESS = {
  addressLine: "1-1-1",
  building: null,
  city: "千代田区",
  country: "JP" as const,
  postalCode: "123-4567",
  prefecture: "東京都",
};

const FIXTURE_INTERNATIONAL_ADDRESS = {
  addressLine1: "1 Market St",
  addressLine2: null,
  city: "San Francisco",
  country: "US" as const,
  postalCode: "94105",
  state: "CA",
};

/** Default full profile used by fixtures that need an active-shaped user. */
const FIXTURE_PROFILE = {
  accountType: "individual" as const,
  address: FIXTURE_JAPAN_ADDRESS,
  business: null,
  dateOfBirth: "1990-01-01",
  gender: "no_answer" as const,
  name: "Integration User",
  nameKana: "インテグレーションユーザー",
  newsletterOptIn: false,
  phoneNumber: "090-1234-5678",
};

/**
 * Builds a full-profile registration Callable payload for one email.
 *
 * @param {string} email Fixture email.
 * @param {Record<string, unknown>} overrides Fields to override.
 * @return {Record<string, unknown>} Registration Callable payload.
 */
function buildRegistrationPayload(
  email: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email,
    password: TEST_PASSWORD,
    ...FIXTURE_PROFILE,
    ...overrides,
  };
}
const CLEAR_SESSION_COOKIE =
  `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; ` +
  "SameSite=Strict";
const SESSION_MAX_AGE_SECONDS = Math.floor(
  SESSION_COOKIE_EXPIRES_IN_MS / 1_000,
);

const fixtureEmails = new Set<string>();
const fixtureUserIds = new Set<string>();
const fixtureVerifiedEmails = new Set<string>();
const functionsTest = firebaseFunctionsTest({projectId: PROJECT_ID});
const wrappedRegister = functionsTest.wrap(registerWithEmailPassword);

interface AuthRestPayload {
  email?: unknown;
  error?: {message?: unknown};
  idToken?: unknown;
  localId?: unknown;
}

interface AuthIdentity {
  email: string;
  idToken: string;
  uid: string;
}

/**
 * Creates an isolated email address for one test fixture.
 *
 * @param {string} domain Email domain.
 * @return {string} Unique email address.
 */
function uniqueEmail(domain = "example.com"): string {
  return `auth-integration-${randomUUID()}@${domain}`;
}

/**
 * Seeds a live verification grant for one address.
 *
 * `registerWithEmailPassword` refuses an address that never passed the
 * wizard's step 2, so every registration fixture has to have "verified" its
 * address first. Written straight through the Admin SDK rather than by
 * calling the verification Callables, so a registration test fails for
 * registration reasons only.
 *
 * @param {string} email Address to mark as verified.
 * @return {Promise<void>} Resolves once the grant exists.
 */
async function grantEmailVerification(email: string): Promise<void> {
  fixtureVerifiedEmails.add(email);
  const nowMs = Date.now();
  await verificationDocument(email).set({
    attemptsRemaining: VERIFICATION_MAX_ATTEMPTS,
    code: "000000",
    createdAt: Timestamp.fromMillis(nowMs),
    email: email.toLowerCase(),
    expiresAt: Timestamp.fromMillis(nowMs + VERIFICATION_CODE_TTL_MS),
    resendAvailableAt: Timestamp.fromMillis(nowMs),
    updatedAt: Timestamp.fromMillis(nowMs),
    verified: true,
    verifiedUntil: Timestamp.fromMillis(nowMs + VERIFICATION_GRANT_TTL_MS),
  });
}

/**
 * Builds the request shape expected by a wrapped v2 callable function.
 *
 * @param {T} data Callable data.
 * @return {CallableRequest<T>} Minimal wrapped request.
 */
function callableRequest<T>(data: T): CallableRequest<T> {
  return {
    acceptsStreaming: false,
    data,
    rawRequest: {} as CallableRequest<T>["rawRequest"],
  };
}

/**
 * Reads an Auth Emulator REST response without trusting its JSON shape.
 *
 * @param {Response} response Fetch response.
 * @return {Promise<AuthRestPayload>} Untrusted Auth payload.
 */
async function readAuthPayload(response: Response): Promise<AuthRestPayload> {
  return await response.json() as AuthRestPayload;
}

/**
 * Sends one Identity Toolkit REST request to the Auth Emulator.
 *
 * @param {string} operation Identity Toolkit operation.
 * @param {Record<string, unknown>} body JSON request body.
 * @return {Promise<object>} Fetch response and decoded payload.
 */
async function callAuthApi(
  operation: string,
  body: Record<string, unknown>,
): Promise<{payload: AuthRestPayload; response: Response}> {
  const response = await fetch(
    `${AUTH_API_BASE}/accounts:${operation}?key=${API_KEY}`,
    {
      body: JSON.stringify(body),
      headers: {"Content-Type": "application/json"},
      method: "POST",
    },
  );
  return {payload: await readAuthPayload(response), response};
}

/**
 * Requires the Auth Emulator to return a usable local ID and ID token.
 *
 * @param {string} email Fixture email.
 * @param {Response} response Fetch response.
 * @param {AuthRestPayload} payload Auth response payload.
 * @return {AuthIdentity} Validated Auth identity.
 */
function requireIdentity(
  email: string,
  response: Response,
  payload: AuthRestPayload,
): AuthIdentity {
  assert.equal(
    response.ok,
    true,
    `Auth Emulator request failed: ${JSON.stringify(payload)}`,
  );
  assert.equal(typeof payload.idToken, "string");
  assert.equal(typeof payload.localId, "string");
  if (typeof payload.idToken !== "string" ||
      typeof payload.localId !== "string") {
    throw new Error("Auth Emulator response omitted identity fields.");
  }
  fixtureEmails.add(email);
  fixtureUserIds.add(payload.localId);
  return {
    email,
    idToken: payload.idToken,
    uid: payload.localId,
  };
}

/**
 * Creates a Google-provider identity using the Auth Emulator's fake IdP.
 *
 * @param {string} email Fixture email.
 * @return {Promise<AuthIdentity>} Created identity and ID token.
 */
async function createGoogleIdentity(email: string): Promise<AuthIdentity> {
  fixtureEmails.add(email);
  const fakeGoogleClaims = JSON.stringify({
    email,
    email_verified: true,
    name: "Integration User",
    sub: randomUUID(),
  });
  const postBody = new URLSearchParams({
    id_token: fakeGoogleClaims,
    providerId: AUTH_PROVIDER.GOOGLE,
  }).toString();
  const {payload, response} = await callAuthApi("signInWithIdp", {
    postBody,
    requestUri: "http://localhost",
    returnIdpCredential: true,
    returnSecureToken: true,
  });
  return requireIdentity(email, response, payload);
}

/**
 * Signs in a password user through the Auth Emulator's client REST path.
 *
 * @param {string} email Fixture email.
 * @return {Promise<AuthIdentity>} Signed-in identity and ID token.
 */
async function signInWithPassword(email: string): Promise<AuthIdentity> {
  const {payload, response} = await callAuthApi("signInWithPassword", {
    email,
    password: TEST_PASSWORD,
    returnSecureToken: true,
  });
  return requireIdentity(email, response, payload);
}

/**
 * Creates an Auth user through the Admin SDK and tracks it for cleanup.
 *
 * @param {string} email Fixture email.
 * @return {Promise<UserRecord>} Created Auth user.
 */
async function createAdminPasswordUser(email: string): Promise<UserRecord> {
  fixtureEmails.add(email);
  const user = await auth().createUser({email, password: TEST_PASSWORD});
  fixtureUserIds.add(user.uid);
  return user;
}

/**
 * Writes a complete users/{uid} fixture document.
 *
 * @param {AuthIdentity} identity Fixture identity.
 * @param {string} authProvider Stored provider.
 * @param {string} status Stored account status.
 * @param {Timestamp|null} scheduledPurgeAt Optional purge deadline.
 * @return {Promise<void>} Resolves after the fixture is written.
 */
async function seedUserDocument(
  identity: Pick<AuthIdentity, "email" | "uid">,
  authProvider: UserDocument["authProvider"],
  status: UserDocument["status"],
  scheduledPurgeAt: Timestamp | null = null,
): Promise<void> {
  const now = Timestamp.now();
  const common = {
    authProvider,
    createdAt: now,
    deletionRequestedAt:
      status === USER_STATUS.PENDING_DELETION ? now : null,
    email: identity.email,
    purgeTaskName:
      status === USER_STATUS.PENDING_DELETION ? randomUUID() : null,
    scheduledPurgeAt,
    uid: identity.uid,
    updatedAt: now,
  };
  fixtureUserIds.add(identity.uid);

  // `UserDocument` is a status-discriminated union: `profile` is `null`
  // only for `pending_additional_info`, never for the other three statuses.
  const isPendingAdditionalInfo =
    status === USER_STATUS.PENDING_ADDITIONAL_INFO;
  const document: UserDocument = isPendingAdditionalInfo ?
    {...common, profile: null, status} :
    {...common, profile: FIXTURE_PROFILE, status};
  await userDocument(identity.uid).set(document);
}

/**
 * Calls one deployed HTTP function through the Functions Emulator.
 *
 * @param {string} functionName Exported function name.
 * @param {RequestInit} init Fetch options.
 * @return {Promise<Response>} HTTP response.
 */
async function callHttpFunction(
  functionName: "sessionLogin" | "sessionLogout",
  init: RequestInit,
): Promise<Response> {
  return await fetch(`${FUNCTIONS_API_BASE}/${functionName}`, init);
}

/**
 * Calls sessionLogin with the contract's JSON and CSRF headers.
 *
 * @param {string} idToken Firebase ID token.
 * @param {string|null} headerCsrfToken Header token, or null to omit it.
 * @param {string} bodyCsrfToken Body token.
 * @return {Promise<Response>} HTTP response.
 */
async function callSessionLogin(
  idToken: string,
  headerCsrfToken: string | null = CSRF_TOKEN,
  bodyCsrfToken = CSRF_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (headerCsrfToken !== null) {
    headers["X-CSRF-Token"] = headerCsrfToken;
  }
  return await callHttpFunction("sessionLogin", {
    body: JSON.stringify({csrfToken: bodyCsrfToken, idToken}),
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
 * Checks a promise rejected with the expected callable HttpsError code.
 *
 * @param {Promise<unknown>} promise Callable invocation.
 * @param {string} expectedCode Expected Firebase Functions error code.
 * @return {Promise<void>} Resolves after the rejection is verified.
 */
async function assertHttpsError(
  promise: Promise<unknown>,
  expectedCode: HttpsError["code"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return error instanceof HttpsError && error.code === expectedCode;
  });
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

  for (const email of fixtureEmails) {
    try {
      const user = await auth().getUserByEmail(email);
      await userDocument(user.uid).delete();
      await auth().deleteUser(user.uid);
    } catch (error: unknown) {
      if (!isUserNotFound(error)) {
        throw error;
      }
    }
  }

  for (const email of fixtureVerifiedEmails) {
    await verificationDocument(email).delete();
  }

  fixtureUserIds.clear();
  fixtureEmails.clear();
  fixtureVerifiedEmails.clear();
});

after(() => {
  functionsTest.cleanup();
});

describe("registerWithEmailPassword", () => {
  it("creates an active password user and Firestore document", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);

    const result = await wrappedRegister(
      callableRequest(buildRegistrationPayload(email)),
    );

    assert.equal(result.status, USER_STATUS.ACTIVE);
    assert.equal(typeof result.uid, "string");
    fixtureUserIds.add(result.uid);
    const [user, snapshot] = await Promise.all([
      auth().getUser(result.uid),
      userDocument(result.uid).get(),
    ]);
    assert.equal(user.email, email);
    assert.equal(snapshot.exists, true);
    const stored = snapshot.data();
    assert.equal(stored?.status, USER_STATUS.ACTIVE);
    assert.equal(stored?.authProvider, AUTH_PROVIDER.PASSWORD);
    assert.equal(stored?.status === USER_STATUS.ACTIVE, true);
    if (stored?.status === USER_STATUS.ACTIVE) {
      assert.deepEqual(stored.profile, FIXTURE_PROFILE);
    }
  });

  it("persists the full nested profile for a corporate account, including " +
    "business info", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);
    const business = {
      companyName: "Integration Corp.",
      contactPerson: "Integration Contact",
      department: null,
    };

    const result = await wrappedRegister(callableRequest(
      buildRegistrationPayload(email, {accountType: "corporate", business}),
    ));

    fixtureUserIds.add(result.uid);
    const stored = (await userDocument(result.uid).get()).data();
    assert.equal(stored?.status === USER_STATUS.ACTIVE, true);
    if (stored?.status === USER_STATUS.ACTIVE) {
      assert.equal(stored.profile.accountType, "corporate");
      assert.deepEqual(stored.profile.business, business);
    }
  });

  it("persists an international address unchanged (the non-Japan branch " +
    "of the address discriminated union), verified through a real " +
    "Firestore round trip", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);

    const result = await wrappedRegister(callableRequest(
      buildRegistrationPayload(email, {address: FIXTURE_INTERNATIONAL_ADDRESS}),
    ));

    fixtureUserIds.add(result.uid);
    const stored = (await userDocument(result.uid).get()).data();
    assert.equal(stored?.status === USER_STATUS.ACTIVE, true);
    if (stored?.status === USER_STATUS.ACTIVE) {
      assert.deepEqual(stored.profile.address, FIXTURE_INTERNATIONAL_ADDRESS);
    }
  });

  it("persists a sole-proprietor registration with its business info, " +
    "with accountType stored as 'sole-proprietor'", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);
    const business = {
      companyName: "Integration Trade Name",
      contactPerson: "Integration Contact",
      department: null,
    };

    const result = await wrappedRegister(callableRequest(
      buildRegistrationPayload(email, {
        accountType: "sole-proprietor",
        business,
      }),
    ));

    fixtureUserIds.add(result.uid);
    const stored = (await userDocument(result.uid).get()).data();
    assert.equal(stored?.status === USER_STATUS.ACTIVE, true);
    if (stored?.status === USER_STATUS.ACTIVE) {
      assert.equal(stored.profile.accountType, "sole-proprietor");
      assert.deepEqual(stored.profile.business, business);
    }
  });

  it("never persists the plaintext password anywhere on the Firestore " +
    "document", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);

    const result = await wrappedRegister(
      callableRequest(buildRegistrationPayload(email)),
    );

    fixtureUserIds.add(result.uid);
    const stored = (await userDocument(result.uid).get()).data();
    assert.equal(
      JSON.stringify(stored).includes(TEST_PASSWORD),
      false,
      "the plaintext password must never be persisted on the user document",
    );
  });

  it("rejects an email outside example.com before creating fixtures",
    async () => {
      const email = uniqueEmail("not-example.test");
      fixtureEmails.add(email);

      await assertHttpsError(
        wrappedRegister(callableRequest(buildRegistrationPayload(email))),
        "invalid-argument",
      );
      await assert.rejects(auth().getUserByEmail(email), isUserNotFound);
    });

  it("refuses an address that never passed the verification step",
    async () => {
      const email = uniqueEmail();
      fixtureEmails.add(email);

      await assertHttpsError(
        wrappedRegister(callableRequest(buildRegistrationPayload(email))),
        "failed-precondition",
      );
      await assert.rejects(auth().getUserByEmail(email), isUserNotFound);
    });

  it("spends the verification grant, so it cannot be replayed", async () => {
    const email = uniqueEmail();
    fixtureEmails.add(email);
    await grantEmailVerification(email);

    const result = await wrappedRegister(
      callableRequest(buildRegistrationPayload(email)),
    );
    fixtureUserIds.add(result.uid);

    assert.equal(
      (await verificationDocument(email).get()).exists,
      false,
      "the grant must not survive the registration that spent it",
    );
  });

  it("rejects a duplicate active account", async () => {
    const user = await createAdminPasswordUser(uniqueEmail());
    await grantEmailVerification(user.email as string);
    await seedUserDocument(
      {email: user.email as string, uid: user.uid},
      AUTH_PROVIDER.PASSWORD,
      USER_STATUS.ACTIVE,
    );

    await assertHttpsError(
      wrappedRegister(callableRequest(
        buildRegistrationPayload(user.email as string),
      )),
      "already-exists",
    );
  });

  it("rejects accounts in pending_deletion and purging states", async () => {
    for (const status of [
      USER_STATUS.PENDING_DELETION,
      USER_STATUS.PURGING,
    ] as const) {
      const user = await createAdminPasswordUser(uniqueEmail());
      await grantEmailVerification(user.email as string);
      await seedUserDocument(
        {email: user.email as string, uid: user.uid},
        AUTH_PROVIDER.PASSWORD,
        status,
        status === USER_STATUS.PENDING_DELETION ?
          Timestamp.fromMillis(Date.now() + MILLISECONDS_PER_DAY) : null,
      );

      await assertHttpsError(
        wrappedRegister(callableRequest(
          buildRegistrationPayload(user.email as string),
        )),
        "already-exists",
      );
    }
  });
});

describe("sessionLogin", () => {
  it("creates pending additional info for a new Google identity", async () => {
    const identity = await createGoogleIdentity(
      uniqueEmail("outside-example.test"),
    );

    const response = await callSessionLogin(identity.idToken);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), CLEAR_SESSION_COOKIE);
    assert.deepEqual(await response.json(), {
      status: "additional_info_required",
    });
    const snapshot = await userDocument(identity.uid).get();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.data()?.status, USER_STATUS.PENDING_ADDITIONAL_INFO);
    assert.equal(snapshot.data()?.authProvider, AUTH_PROVIDER.GOOGLE);
    assert.equal(snapshot.data()?.email, identity.email);
    assert.equal(snapshot.data()?.profile, null);
  });

  it("issues the contract session cookie for an active user", async () => {
    const identity = await createGoogleIdentity(uniqueEmail());
    await seedUserDocument(
      identity,
      AUTH_PROVIDER.GOOGLE,
      USER_STATUS.ACTIVE,
    );

    const response = await callSessionLogin(identity.idToken);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {status: "ok"});
    const setCookie = response.headers.get("set-cookie");
    assert.match(
      setCookie ?? "",
      new RegExp(
        `^${SESSION_COOKIE_NAME}=[^;]+; Max-Age=` +
        `${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; ` +
        "SameSite=Strict$",
      ),
    );
    await auth().verifySessionCookie(readIssuedSessionCookie(response), true);
  });

  it("returns deletion timing without issuing a session", async () => {
    const identity = await createGoogleIdentity(uniqueEmail());
    const purgeAt = Timestamp.fromMillis(
      Date.now() + 2 * MILLISECONDS_PER_DAY,
    );
    await seedUserDocument(
      identity,
      AUTH_PROVIDER.GOOGLE,
      USER_STATUS.PENDING_DELETION,
      purgeAt,
    );

    const response = await callSessionLogin(identity.idToken);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), CLEAR_SESSION_COOKIE);
    assert.deepEqual(await response.json(), {
      daysRemaining: 2,
      scheduledPurgeAt: purgeAt.toDate().toISOString(),
      status: USER_STATUS.PENDING_DELETION,
    });
  });

  it("rejects missing and mismatched double-submit CSRF tokens", async () => {
    const missingHeader = await callSessionLogin(
      "unused-id-token",
      null,
    );
    assert.equal(missingHeader.status, 403);
    assert.deepEqual(await missingHeader.json(), {
      error: {
        code: "permission-denied",
        message: "Request rejected.",
      },
    });

    const mismatchedHeader = await callSessionLogin(
      "unused-id-token",
      "different-token",
    );
    assert.equal(mismatchedHeader.status, 403);
    assert.deepEqual(await mismatchedHeader.json(), {
      error: {
        code: "permission-denied",
        message: "Request rejected.",
      },
    });
  });

  it("rejects non-POST methods with the Allow header", async () => {
    const response = await callHttpFunction("sessionLogin", {method: "GET"});

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.deepEqual(await response.json(), {
      error: {
        code: "method-not-allowed",
        message: "Only POST requests are accepted.",
      },
    });
  });
});

describe("sessionLogout", () => {
  it("revokes a valid session and clears its cookie", async () => {
    const email = uniqueEmail();
    const user = await createAdminPasswordUser(email);
    const identity = await signInWithPassword(email);
    await seedUserDocument(
      identity,
      AUTH_PROVIDER.PASSWORD,
      USER_STATUS.ACTIVE,
    );
    assert.equal(identity.uid, user.uid);
    const loginResponse = await callSessionLogin(identity.idToken);
    assert.equal(loginResponse.status, 200);
    const sessionCookie = readIssuedSessionCookie(loginResponse);
    await auth().verifySessionCookie(sessionCookie, true);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await callHttpFunction("sessionLogout", {
      body: JSON.stringify({csrfToken: CSRF_TOKEN}),
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        "X-CSRF-Token": CSRF_TOKEN,
      },
      method: "POST",
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), CLEAR_SESSION_COOKIE);
    assert.deepEqual(await response.json(), {status: "ok"});
    await assert.rejects(auth().verifySessionCookie(sessionCookie, true));
  });

  it("rejects a missing or mismatched double-submit CSRF token, without " +
    "touching the session cookie", async () => {
    const csrfHeaderVariants: Record<string, string>[] = [
      {"Content-Type": "application/json"},
      {
        "Content-Type": "application/json",
        "X-CSRF-Token": "a-different-token",
      },
    ];
    for (const csrfHeaders of csrfHeaderVariants) {
      const response = await callHttpFunction("sessionLogout", {
        body: JSON.stringify({csrfToken: CSRF_TOKEN}),
        headers: {
          ...csrfHeaders,
          Cookie: `${SESSION_COOKIE_NAME}=irrelevant-for-this-check`,
        },
        method: "POST",
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.deepEqual(await response.json(), {
        error: {
          code: "permission-denied",
          message: "Request rejected.",
        },
      });
    }
  });

  it("clears the cookie for missing and invalid credentials, once the " +
    "CSRF check has passed", async () => {
    const headerVariants: Record<string, string>[] = [
      {"Content-Type": "application/json", "X-CSRF-Token": CSRF_TOKEN},
      {
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE_NAME}=invalid-session-cookie`,
        "X-CSRF-Token": CSRF_TOKEN,
      },
    ];
    for (const headers of headerVariants) {
      const response = await callHttpFunction("sessionLogout", {
        body: JSON.stringify({csrfToken: CSRF_TOKEN}),
        headers,
        method: "POST",
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), CLEAR_SESSION_COOKIE);
      assert.deepEqual(await response.json(), {
        error: {
          code: "unauthenticated",
          message: "Authentication failed.",
        },
      });
    }
  });
});
