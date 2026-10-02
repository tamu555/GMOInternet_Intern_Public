/**
 * The authorization gate every member-facing Callable passes through.
 *
 * `request.auth` proves only that Firebase Authentication minted an ID token
 * for this uid. It does not prove the caller ever completed registration:
 * Identity Toolkit's `accounts:signUp` endpoint is public and reachable with
 * the Web API key that ships inside the frontend bundle, so anyone can mint a
 * valid ID token for this project without going anywhere near
 * `registerWithEmailPassword`. Such a caller passes `if (!request.auth)` and
 * holds no `users/{uid}` document at all - which is why the document's
 * presence, and its status, is the real gate.
 *
 * The blocking function `enforceAllowedEmailDomainOnCreate` used to be read
 * as this project's answer to that hole. It never was: it checked the address
 * domain, not whether the signup wizard had been completed, so an allowed
 * domain was enough to walk straight past it into every `api/` Callable.
 *
 * Where this belongs: at the top of the `onCall` body, before the `handle*`
 * function, so the gate is visible at the trigger boundary and the handlers
 * stay unit-testable without a live Firestore. `callerGuardCoverage.test.ts`
 * fails the build if an `api/` Callable is added without it.
 *
 * Who does not use it:
 *   - `auth/account-lifecycle.ts` and `auth/session.ts` read the same
 *     document inside the transactions they need anyway, and each accepts a
 *     different status (`restoreAccount` wants `pending_deletion`,
 *     `submitAdditionalInfo` wants `pending_additional_info`), so an
 *     "active only" helper would be wrong for them.
 *   - `auth/registration.ts` and `auth/verification.ts` run before any
 *     account exists.
 *   - `api/listTlds.ts`, `api/searchDomains.ts`, and
 *     `api/devForceRegistry503.ts` are deliberately public; each documents
 *     why in its own module header. Searching is what the public top page
 *     does; sign-in is what buying requires.
 *
 * Relation to `domain/domainRepository.ts`'s `isActiveMember`: that is the
 * same rule as a bare boolean, and `listDomains` / `getDomainInfo` - the only
 * two Callables that were already gated correctly before this guard existed -
 * still call it inside their handlers. Those two therefore read
 * `users/{uid}` twice per invocation. That is deliberate: the inner check is
 * what their unit tests pin, and one extra document read is a cheap price for
 * a gate that survives someone later refactoring the trigger wrapper.
 */
import type {DocumentReference} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {HttpsError} from "firebase-functions/v2/https";

import {USER_STATUS} from "./constants.js";
import {userDocument} from "./firestore.js";
import type {UserDocument} from "./types.js";

/** Matches the wording every existing `api/` Callable already used. */
export const UNAUTHENTICATED_MESSAGE = "ログインが必要です。";

/**
 * One message for "no document", "half-registered", and "being deleted"
 * alike. The caller cannot act on the distinction, and spelling it out would
 * confirm to whoever minted a token straight against `accounts:signUp`
 * exactly which check they tripped. The reason goes to Cloud Logging.
 */
export const NOT_A_MEMBER_MESSAGE = "この操作を実行する権限がありません。";

/** What the guard needs from Firestore, substitutable in tests. */
export interface CallerGuardDependencies {
  userDocument: (uid: string) => DocumentReference<UserDocument>;
}

const defaultDependencies: CallerGuardDependencies = {userDocument};

/**
 * Requires a caller who is signed in AND holds an active `users/{uid}`
 * document, and returns their uid.
 *
 * @param {{uid: string}|undefined} auth `request.auth` from the Callable.
 * @param {CallerGuardDependencies} dependencies Injectable dependencies.
 * @return {Promise<string>} The authenticated, registered caller's uid.
 */
export async function requireActiveUser(
  auth: {uid: string} | undefined,
  dependencies: CallerGuardDependencies = defaultDependencies,
): Promise<string> {
  if (!auth) {
    throw new HttpsError("unauthenticated", UNAUTHENTICATED_MESSAGE);
  }

  const uid = auth.uid;
  let user: UserDocument | undefined;
  try {
    user = (await dependencies.userDocument(uid).get()).data();
  } catch (error: unknown) {
    // A Firestore outage must not be answered as "you are not a member":
    // that would tell a legitimate member their account is gone, and it
    // would invite a retry that cannot succeed. `internal` is the honest
    // answer, and the client already treats it as a server fault.
    logger.error("Failed to read the caller's user document.", {
      uid,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    throw new HttpsError("internal", "処理できませんでした。");
  }

  if (!user) {
    logger.warn("Rejected a caller that holds no user document.", {uid});
    throw new HttpsError("permission-denied", NOT_A_MEMBER_MESSAGE);
  }

  if (user.status !== USER_STATUS.ACTIVE) {
    logger.warn("Rejected a caller whose account is not active.", {
      uid,
      status: user.status,
    });
    throw new HttpsError("permission-denied", NOT_A_MEMBER_MESSAGE);
  }

  return uid;
}
