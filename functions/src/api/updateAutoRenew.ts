/**
 * `updateAutoRenew` — the app-side auto-renew flag write (FIG.9/10, §6.4).
 *
 * `autoRenew` exists ONLY in the Firestore mirror: the registry has no OFF
 * switch and renews unconditionally (§3.6), so this flag is what the planned
 * exDate batch delete would honour (TBD #15). No registry call is made and
 * no secrets are needed. This replaces the autoRenew half of the deleted
 * functions-stubs `updateMyDomain` — its NS/locks half already speaks the
 * real `updateDomain`.
 *
 * A `pendingDelete` domain is refused: delete forces the flag to false and
 * records `autoRenewBeforeDelete` for restore (`domainLifecycle.ts`), so a
 * client write in that window would be silently undone by the restore. The
 * UI disables the switch there too; this is the server-side backstop.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {FieldValue} from "firebase-admin/firestore";
import {requireActiveUser} from "../auth/callerGuard";
import {db} from "../config/firebase";
import {assertOwnsDomain} from "../domain/ownership";
import {normaliseDomainName, ValidationError} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Response returned to the client. */
export interface UpdateAutoRenewResponse {
  domainName: string;
  autoRenew: boolean;
}

/** Dependencies the handler needs, substitutable in tests. */
export interface UpdateAutoRenewDependencies {
  writeAutoRenew(
    uid: string,
    domainName: string,
    autoRenew: boolean,
  ): Promise<void>;
}

/**
 * Refuses the write while the mirror reports `pendingDelete` (see module
 * doc). A missing or malformed status list is treated as writable — the
 * ownership check has already vouched for the document.
 *
 * @param {unknown} status Raw `status` field from the mirror document.
 */
export function assertAutoRenewWritable(status: unknown): void {
  if (Array.isArray(status) && status.includes("pendingDelete")) {
    throw new HttpsError(
      "failed-precondition",
      "廃止手続き中のため自動更新の設定は変更できません。復旧後にやり直してください。",
    );
  }
}

/**
 * Production write path: ownership check, then a transactional flag update
 * that re-reads the mirror so the `pendingDelete` guard and the write see
 * the same document state.
 *
 * @param {string} uid Caller uid.
 * @param {string} domainName Canonical domain name.
 * @param {boolean} autoRenew New flag value.
 * @return {Promise<void>} Resolves when the mirror is updated.
 */
async function writeAutoRenewInMirror(
  uid: string,
  domainName: string,
  autoRenew: boolean,
): Promise<void> {
  const firestore = db();
  const owned = await assertOwnsDomain(uid, domainName, firestore);
  await firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(owned.ref);
    const data = snapshot.data();
    if (!data || data.uid !== uid || data.name !== domainName) {
      // Vanished between the ownership check and the write; keep the same
      // wording as the ownership failure so nothing new is revealed.
      throw new HttpsError(
        "permission-denied",
        "対象のドメインが見つからないか、このアカウントの所有物ではありません。",
      );
    }
    assertAutoRenewWritable(data.status);
    tx.update(owned.ref, {
      autoRenew,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

const defaultDependencies: UpdateAutoRenewDependencies = {
  writeAutoRenew: writeAutoRenewInMirror,
};

/**
 * Handles one `updateAutoRenew` invocation: auth → input validation →
 * ownership-gated mirror write. The new value is echoed back; the detail
 * screen re-reads via `listDomains`/`getDomainInfo` anyway.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {UpdateAutoRenewDependencies} dependencies Injectable dependencies.
 * @return {Promise<UpdateAutoRenewResponse>} The stored flag, echoed back.
 */
export async function handleUpdateAutoRenew(
  request: CallableRequest<unknown>,
  dependencies: UpdateAutoRenewDependencies = defaultDependencies,
): Promise<UpdateAutoRenewResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const uid = request.auth.uid;

  try {
    const data = (request.data ?? {}) as {
      domainName?: unknown;
      autoRenew?: unknown;
    };
    if (typeof data.domainName !== "string") {
      throw new ValidationError(
        "domainName",
        "ドメイン名は文字列で指定してください。",
      );
    }
    const domainName = normaliseDomainName(data.domainName);
    if (typeof data.autoRenew !== "boolean") {
      throw new ValidationError(
        "autoRenew",
        "autoRenewは真偽値で指定してください。",
      );
    }

    await dependencies.writeAutoRenew(uid, domainName, data.autoRenew);
    return {domainName, autoRenew: data.autoRenew};
  } catch (error) {
    throw toHttpsError(error, "updateAutoRenew");
  }
}

/** Production `updateAutoRenew` Callable. */
export const updateAutoRenew = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleUpdateAutoRenew(request);
});
