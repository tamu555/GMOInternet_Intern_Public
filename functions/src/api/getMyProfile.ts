/**
 * `getMyProfile` — lets an authenticated, active member read their own
 * `users/{uid}` document (My Page profile screen).
 *
 * `sessionMe` (`auth/session.ts`) only ever returned `{id, email,
 * displayName}` for the cookie-session onRequest endpoints; nothing exposed
 * `authProvider` or the rest of `UserProfile` to the client, and
 * `firestore.rules` denies every client read of `users/{uid}` outright. This
 * Callable is the one sanctioned path in: `requireActiveUser` gates it the
 * same way every other `api/` Callable is gated, and `serializeUserDocument`
 * is the single place that decides which stored fields are safe to return
 * (never `purgeTaskName`, `deletionRequestedAt`, or `scheduledPurgeAt` -
 * those are deletion-flow internals, not profile data).
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {NOT_A_MEMBER_MESSAGE, requireActiveUser} from "../auth/callerGuard";
import {userDocument} from "../auth/firestore";
import type {AuthProvider, UserDocument, UserProfile, UserStatus}
  from "../auth/types";
import {toHttpsError} from "./httpsErrors";

/**
 * Response returned to the client. Deliberately a strict projection of
 * `UserDocument`, not the document itself: timestamps go out as ISO
 * strings, and deletion-flow-only fields never leave the server.
 */
export interface GetMyProfileResponse {
  uid: string;
  email: string;
  authProvider: AuthProvider;
  status: UserStatus;
  profile: UserProfile | null;
  createdAt: string;
  updatedAt: string;
}

/** Dependencies the handler needs, substitutable in tests. */
export interface GetMyProfileDependencies {
  loadUser(uid: string): Promise<UserDocument | null>;
}

/**
 * Production read path: a single `users/{uid}` document read.
 *
 * @param {string} uid Caller uid.
 * @return {Promise<UserDocument | null>} The stored document, or null.
 */
async function loadUserFromFirestore(
  uid: string,
): Promise<UserDocument | null> {
  const snapshot = await userDocument(uid).get();
  return snapshot.data() ?? null;
}

const defaultDependencies: GetMyProfileDependencies = {
  loadUser: loadUserFromFirestore,
};

/**
 * Projects a stored `UserDocument` onto the client-safe response shape.
 *
 * @param {UserDocument} user Stored user document.
 * @return {GetMyProfileResponse} Wire-shaped, PII-scoped-to-owner response.
 */
export function serializeUserDocument(
  user: UserDocument,
): GetMyProfileResponse {
  return {
    uid: user.uid,
    email: user.email,
    authProvider: user.authProvider,
    status: user.status,
    profile: user.profile,
    createdAt: user.createdAt.toDate().toISOString(),
    updatedAt: user.updatedAt.toDate().toISOString(),
  };
}

/**
 * Handles one `getMyProfile` invocation: auth → own-document load →
 * serialize. The `!user` branch is a defensive backstop (production traffic
 * never reaches it, since `requireActiveUser` already required the same
 * document to exist and be active) that keeps this handler unit-testable on
 * its own contract.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {GetMyProfileDependencies} dependencies Injectable dependencies.
 * @return {Promise<GetMyProfileResponse>} The caller's own profile.
 */
export async function handleGetMyProfile(
  request: CallableRequest<unknown>,
  dependencies: GetMyProfileDependencies = defaultDependencies,
): Promise<GetMyProfileResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const uid = request.auth.uid;

  try {
    const user = await dependencies.loadUser(uid);
    if (!user) {
      throw new HttpsError("permission-denied", NOT_A_MEMBER_MESSAGE);
    }
    return serializeUserDocument(user);
  } catch (error) {
    throw toHttpsError(error, "getMyProfile");
  }
}

/** Production `getMyProfile` Callable. */
export const getMyProfile = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleGetMyProfile(request);
});
