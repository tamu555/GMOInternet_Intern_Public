/**
 * `updateMyProfile` — lets an authenticated, active member replace their own
 * `users/{uid}.profile` (My Page profile edit screen).
 *
 * Full-replacement, not a patch: the request shape is `{profile: UserProfile}`
 * validated with the same `profileSchema` the signup wizard and
 * `submitAdditionalInfo` already use (`auth/profileSchema.ts`), so a value the
 * wizard would reject can never land here either. The request is parsed with
 * `z.strictObject` so any top-level key besides `profile` - most importantly
 * an attempt to smuggle `uid`/`email`/`authProvider`/`status`/the deletion
 * fields alongside it - is rejected outright before Firestore is touched;
 * the transactional write below only ever sets `profile` and `updatedAt`,
 * which makes every other field immutable by construction, not by a
 * denylist that could grow stale.
 *
 * The transaction re-checks `status === "active"` against the row it is
 * about to write, not just the request-time check `requireActiveUser`
 * already did in the `onCall` wrapper: an account can enter
 * `pending_deletion` between those two points, and the write must not
 * resurrect a profile edit into a document mid-deletion.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {Timestamp} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {z} from "zod";
import {requireActiveUser} from "../auth/callerGuard";
import {USER_STATUS} from "../auth/constants";
import {userDocument} from "../auth/firestore";
import {profileSchema} from "../auth/profileSchema";
import type {UserDocument, UserProfile} from "../auth/types";
import {db} from "../config/firebase";
import {toHttpsError} from "./httpsErrors";
import {serializeUserDocument, type GetMyProfileResponse}
  from "./getMyProfile";

export type {GetMyProfileResponse as UpdateMyProfileResponse};

/**
 * The Callable's request shape. `.strict()` is what makes an unrecognised
 * top-level key (e.g. a caller trying to also pass `status` or `uid`) a
 * validation failure instead of a silently-dropped extra field.
 */
const updateMyProfileInputSchema = z.strictObject({
  profile: profileSchema,
});

/** Message shown for any input validation failure; no field values logged. */
const INVALID_INPUT_MESSAGE = "入力内容を確認してください。";

/** Dependencies the handler needs, substitutable in tests. */
export interface UpdateMyProfileDependencies {
  writeProfile(uid: string, profile: UserProfile): Promise<UserDocument>;
}

/**
 * Production write path: a transaction that re-reads the caller's own
 * document, refuses to write over a non-active status, and updates only
 * `profile` + `updatedAt`.
 *
 * @param {string} uid Caller uid.
 * @param {UserProfile} profile Validated full profile replacement.
 * @return {Promise<UserDocument>} The document as written.
 */
async function writeProfileInFirestore(
  uid: string,
  profile: UserProfile,
): Promise<UserDocument> {
  const reference = userDocument(uid);
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const user = snapshot.data();
    if (!user || user.status !== USER_STATUS.ACTIVE) {
      throw new HttpsError(
        "failed-precondition",
        "アカウントが有効な状態ではないため、プロフィールを更新できません。",
      );
    }

    const updatedAt = Timestamp.now();
    transaction.update(reference, {profile, updatedAt});
    return {...user, profile, updatedAt} as UserDocument;
  });
}

const defaultDependencies: UpdateMyProfileDependencies = {
  writeProfile: writeProfileInFirestore,
};

/**
 * Parses and validates the full-profile update input.
 *
 * @param {unknown} data Callable request data.
 * @return {UserProfile} Validated full profile.
 */
function parseUpdateMyProfileInput(data: unknown): UserProfile {
  const parsed = updateMyProfileInputSchema.safeParse(data);
  if (!parsed.success) {
    // Field paths and issue codes only - never the submitted values, which
    // may carry the member's real name, phone number, or address.
    logger.warn("updateMyProfile input failed validation.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
    throw new HttpsError("invalid-argument", INVALID_INPUT_MESSAGE);
  }
  return parsed.data.profile;
}

/**
 * Handles one `updateMyProfile` invocation: auth → input validation →
 * status-gated transactional write → serialize (same shape `getMyProfile`
 * returns, so the client can treat both responses identically).
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {UpdateMyProfileDependencies} dependencies Injectable dependencies.
 * @return {Promise<GetMyProfileResponse>} The caller's profile, post-write.
 */
export async function handleUpdateMyProfile(
  request: CallableRequest<unknown>,
  dependencies: UpdateMyProfileDependencies = defaultDependencies,
): Promise<GetMyProfileResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const uid = request.auth.uid;

  try {
    const profile = parseUpdateMyProfileInput(request.data);
    const user = await dependencies.writeProfile(uid, profile);
    return serializeUserDocument(user);
  } catch (error) {
    throw toHttpsError(error, "updateMyProfile");
  }
}

/** Production `updateMyProfile` Callable. */
export const updateMyProfile = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleUpdateMyProfile(request);
});
