/**
 * `getDomainInfo` — the live domain detail lookup behind FIG.10.
 *
 * Ownership is enforced entirely inside `getLiveDomainInfo()` before any
 * registry client is constructed (spec 7.3's per-request domain-ownership
 * check); this handler only sequences auth, the active-member gate, input
 * normalisation, and the uniform not-found translation for a denied `null`.
 * A missing mirror doc and a doc owned by another member are indistinguishable
 * from here on, by design: both simply come back as `null`.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {normaliseDomainName} from "../domain/validation";
import {isActiveMember} from "../domain/domainRepository";
import {
  getLiveDomainInfo,
  type GetDomainInfoResponse,
} from "../domain/getDomainInfo";
import {toHttpsError} from "./httpsErrors";

/** Shape the client sends. */
export interface GetDomainInfoData {
  domainName?: unknown;
}

/** Dependencies the handler needs, substitutable in tests. */
export interface GetDomainInfoHandlerDependencies {
  isActiveMember(uid: string): Promise<boolean>;
  getLiveDomainInfo(
    uid: string,
    normalizedName: string,
  ): Promise<GetDomainInfoResponse | null>;
}

const defaultDependencies: GetDomainInfoHandlerDependencies = {
  isActiveMember,
  getLiveDomainInfo,
};

/**
 * Handles one `getDomainInfo` invocation.
 *
 * Order is auth -> active-member gate -> `normaliseDomainName()` ->
 * ownership-gated live lookup -> uniform not-found on `null`. This exact
 * order matters: the active-member gate must reject before validation ever
 * runs, and ownership must be settled before any registry call is possible.
 *
 * @param {CallableRequest<GetDomainInfoData>} request Callable request.
 * @param {GetDomainInfoHandlerDependencies} dependencies Injectable
 *   dependencies; defaults to the production ownership-gated implementation.
 * @return {Promise<GetDomainInfoResponse>} Normalised live registry detail.
 */
export async function handleGetDomainInfo(
  request: CallableRequest<GetDomainInfoData>,
  dependencies: GetDomainInfoHandlerDependencies = defaultDependencies,
): Promise<GetDomainInfoResponse> {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const uid = request.auth.uid;

  try {
    const active = await dependencies.isActiveMember(uid);
    if (!active) {
      throw new HttpsError(
        "permission-denied",
        "この操作を行う権限がありません。",
      );
    }

    const normalizedName = normaliseDomainName(
      String(request.data?.domainName ?? ""),
    );

    const info = await dependencies.getLiveDomainInfo(uid, normalizedName);
    if (!info) {
      // Same code/message/no-details as a genuinely nonexistent registry
      // object (see httpsErrors.ts's `objectNotFound` mapping): existence and
      // ownership must both stay unobservable to a non-owner.
      throw new HttpsError(
        "not-found",
        "対象がレジストリに見つかりませんでした。",
      );
    }
    return info;
  } catch (error) {
    throw toHttpsError(error, "getDomainInfo");
  }
}

export const getDomainInfo = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 60},
  async (request) => {
    await requireActiveUser(request.auth);
    return handleGetDomainInfo(request);
  },
);
