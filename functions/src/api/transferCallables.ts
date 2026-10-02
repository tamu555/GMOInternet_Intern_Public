/**
 * The transfer Callables (spec 6.6) — 移管IN と 移管OUT の境界.
 *
 * | Callable            | Side    | EPP command                |
 * |---------------------|---------|----------------------------|
 * | `requestTransfer`   | gaining | `domain:transfer request`  |
 * | `cancelTransfer`    | gaining | `domain:transfer cancel`   |
 * | `respondTransfer`   | losing  | `approve` / `reject`       |
 * | `listTransfers`     | both    | — (Firestore only)         |
 * | `getTransferStatus` | both    | — (Firestore only)         |
 *
 * Thin on purpose, like every other Callable here: authenticate, validate,
 * hand over to the use case, translate whatever comes back. The two read-only
 * ones declare no registry secrets and no raised timeout, because they never
 * leave Firestore — the same split `listDomains` makes.
 *
 * ⚠️ `requestTransfer` is the only mutating Callable in this codebase that
 * acts on a domain the caller does **not** own yet, so the usual
 * `assertOwnsDomain` gate cannot apply. What stands in for it is the AuthCode:
 * the registry only accepts a request whose `authInfo` matches, which is the
 * transfer protocol's own proof of control (spec 6.6.1). The value is
 * validated for shape here and never logged or echoed back.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {
  cancelIncomingTransfer,
  getTransfer,
  listPendingTransfers,
  requestIncomingTransfer,
  respondToOutgoingTransfer,
} from "../domain/transferDomain";
import {
  normaliseDomainName,
  normaliseTransferAction,
  normaliseTransferAuthInfo,
} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/**
 * Rejects an anonymous call and returns the caller's uid.
 *
 * @param {{uid: string} | undefined} auth Callable auth context.
 * @return {string} Firebase Authentication uid.
 */
function requireUid(auth: {uid: string} | undefined): string {
  if (!auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  return auth.uid;
}

/** 移管IN: asks another registrar for a domain, proving it with an AuthCode. */
export const requestTransfer = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    const uid = requireUid(request.auth);
    try {
      const data = (request.data ?? {}) as Record<string, unknown>;
      const domainName = normaliseDomainName(String(data.domainName ?? ""));
      const authInfo = normaliseTransferAuthInfo(data.authInfo);
      return await requestIncomingTransfer(uid, domainName, authInfo);
    } catch (error) {
      throw toHttpsError(error, "requestTransfer");
    }
  },
);

/** 移管IN の取消: withdraws a request the member started. */
export const cancelTransfer = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    const uid = requireUid(request.auth);
    try {
      const data = (request.data ?? {}) as Record<string, unknown>;
      const domainName = normaliseDomainName(String(data.domainName ?? ""));
      return await cancelIncomingTransfer(uid, domainName);
    } catch (error) {
      throw toHttpsError(error, "cancelTransfer");
    }
  },
);

/** 移管OUT: the losing side approves or rejects (FIG.3 下帯). */
export const respondTransfer = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    const uid = requireUid(request.auth);
    try {
      const data = (request.data ?? {}) as Record<string, unknown>;
      const domainName = normaliseDomainName(String(data.domainName ?? ""));
      const action = normaliseTransferAction(data.action);
      return await respondToOutgoingTransfer(uid, domainName, action);
    } catch (error) {
      throw toHttpsError(error, "respondTransfer");
    }
  },
);

/** Every transfer of the caller's that is still waiting on somebody. */
export const listTransfers = onCall(async (request) => {
  await requireActiveUser(request.auth);
  const uid = requireUid(request.auth);
  try {
    return {transfers: await listPendingTransfers(uid)};
  } catch (error) {
    throw toHttpsError(error, "listTransfers");
  }
});

/** One transfer's current state, for a screen polling for the answer. */
export const getTransferStatus = onCall(async (request) => {
  await requireActiveUser(request.auth);
  const uid = requireUid(request.auth);
  try {
    const data = (request.data ?? {}) as Record<string, unknown>;
    const domainName = normaliseDomainName(String(data.domainName ?? ""));
    const transfer = await getTransfer(uid, domainName);
    if (!transfer) {
      throw new HttpsError("not-found", "対象の移管が見つかりません。");
    }
    return transfer;
  } catch (error) {
    throw toHttpsError(error, "getTransferStatus");
  }
});
