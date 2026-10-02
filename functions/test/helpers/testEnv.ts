/**
 * Shared test setup.
 *
 * Import this module **before** anything from `src/`: it sets the environment
 * variables that `config/options.ts` and the Admin SDK read, and the Admin
 * SDK latches onto `FIRESTORE_EMULATOR_HOST` the first time `db()` runs.
 *
 * Integration tests never touch a real project. They refuse to run unless
 * `FIRESTORE_EMULATOR_HOST` is set, and they delete everything they wrote.
 */
import {randomUUID} from "node:crypto";
import {connect} from "node:net";
import {Timestamp} from "firebase-admin/firestore";
import type {CallableFunction} from "firebase-functions/v2/https";

import {AUTH_PROVIDER, USER_STATUS} from "../../src/auth/constants";
import type {ActiveUser} from "../../src/auth/types";
import {COLLECTIONS, db} from "../../src/config/firebase";

process.env.GCLOUD_PROJECT ??= "demo-teamc-2026";
process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT;

// Placeholder credentials. The stub registry checks that both authentication
// layers are present, so these values are asserted on, not ignored.
export const TEST_GATE_USER = "gate-user";
export const TEST_GATE_PASSWORD = "gate-password";
export const TEST_REGISTRAR_ID = "KITAQ-TEST-001";

// The Basic gate and the registrar id are shared by both registries (one
// secret each); only the API key is issued per registry, so the tests keep
// them distinguishable and assert that each registry is called with its own.
export const TEST_KITAQSIGN_API_KEY = "test-api-key-kitaqsign";
export const TEST_KITAQNIC_API_KEY = "test-api-key-kitaqnic";

// Safety net. The BRIDGE layer defaults to the real registries, and a suite
// that forgot `useStubRegistries` would otherwise register and delete real
// domains — the Swagger documentation is explicit that these commands hit
// live data. Pointing both at a closed port makes that mistake fail
// instantly instead of succeeding against production.
const UNROUTABLE = "http://127.0.0.1:1";
process.env.KITAQSIGN_BASE_URL = UNROUTABLE;
process.env.KITAQNIC_BASE_URL = UNROUTABLE;

// src/config/options.ts declares the Basic gate and the registrar id once,
// because both registries share them, and one API key per registry. The API
// keys stay distinct so a mix-up would show up.
process.env.BASIC_GATE_USER = TEST_GATE_USER;
process.env.BASIC_GATE_PASSWORD = TEST_GATE_PASSWORD;
process.env.REGISTRAR_ID = TEST_REGISTRAR_ID;

process.env.KITAQSIGN_API_KEY = TEST_KITAQSIGN_API_KEY;
process.env.KITAQNIC_API_KEY = TEST_KITAQNIC_API_KEY;

/** True when the suite is allowed to talk to Firestore. */
export const HAS_EMULATOR = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

/** Reason shown for skipped suites. */
export const SKIP_REASON =
  "FIRESTORE_EMULATOR_HOST が未設定のためスキップ " +
  "(npm run test:emulator で実行できます)";

/**
 * Fails fast with an actionable message when the emulator is not reachable.
 *
 * @return {Promise<void>} Resolves when a connection succeeded.
 */
export async function requireEmulator(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST as string;
  const [hostname, port] = host.split(":");
  await new Promise<void>((resolve, reject) => {
    const socket = connect({host: hostname, port: Number(port)}, () => {
      socket.end();
      resolve();
    });
    socket.on("error", () =>
      reject(new Error(
        `Firestore エミュレータ (${host}) に接続できません。` +
        "docs/firebase/docker-compose.yml を起動してください。",
      )));
  });
}

/**
 * Points both registries at stub base URLs.
 *
 * @param {string} kitaqsignUrl Base URL of the Kitaqsign stub.
 * @param {string} kitaqnicUrl Base URL of the Kitaqnic stub.
 */
export function useStubRegistries(
  kitaqsignUrl: string,
  kitaqnicUrl: string,
): void {
  process.env.KITAQSIGN_BASE_URL = kitaqsignUrl;
  process.env.KITAQNIC_BASE_URL = kitaqnicUrl;
}

/**
 * Generates a uid that no other test run will collide with.
 *
 * @return {string} Test-only uid.
 */
export function testUid(): string {
  return `test-${randomUUID()}`;
}

/** Minimal but complete profile for a seeded active member fixture. */
const ACTIVE_MEMBER_PROFILE: ActiveUser["profile"] = {
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
 * Allocates a fresh uid and seeds an active `users/{uid}` document for it.
 *
 * `requireActiveUser` (src/auth/callerGuard.ts) rejects any caller who holds
 * no active user document, so every Callable invoked through `callAs` needs
 * one of these unless the test deliberately exercises that rejection.
 *
 * @return {Promise<string>} A fresh uid backed by an active user document.
 */
export async function activeMemberUid(): Promise<string> {
  const uid = testUid();
  const now = Timestamp.now();
  const user: ActiveUser = {
    authProvider: AUTH_PROVIDER.PASSWORD,
    createdAt: now,
    deletionRequestedAt: null,
    email: `${uid}@example.com`,
    profile: ACTIVE_MEMBER_PROFILE,
    purgeTaskName: null,
    scheduledPurgeAt: null,
    status: USER_STATUS.ACTIVE,
    uid,
    updatedAt: now,
  };
  await db().collection(COLLECTIONS.users).doc(uid).set(user);
  return uid;
}

/**
 * Generates a well-formed idempotency key.
 *
 * @return {string} Key accepted by `validateIdempotencyKey`.
 */
export function testIdempotencyKey(): string {
  return `key-${randomUUID()}`;
}

/** Minimal shape a Callable needs in tests. */
interface FakeCallableRequest {
  data: unknown;
  auth?: {uid: string; token: Record<string, unknown>};
  rawRequest: unknown;
  acceptsStreaming: boolean;
}

/**
 * Invokes a Callable as a signed-in member.
 *
 * @param {CallableFunction} fn Callable to run.
 * @param {unknown} data Request payload.
 * @param {string | undefined} uid Caller uid, omitted for anonymous.
 * @return {Promise<T>} Whatever the Callable returned.
 */
export function callAs<T>(
  fn: CallableFunction<unknown, T | Promise<T>>,
  data: unknown,
  uid?: string,
): Promise<T> {
  const request: FakeCallableRequest = {
    data,
    auth: uid ? {uid, token: {}} : undefined,
    rawRequest: {},
    acceptsStreaming: false,
  };
  return Promise.resolve(
    fn.run(request as unknown as Parameters<typeof fn.run>[0]),
  );
}

/**
 * Asserts that a Callable rejects, and returns the thrown error code.
 *
 * @param {Promise<unknown>} promise Call in flight.
 * @return {Promise<string>} The `code` of the HttpsError.
 */
export async function expectHttpsError(
  promise: Promise<unknown>,
): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as {code?: string}).code ?? "unknown";
  }
  throw new Error("エラーが投げられませんでした");
}
