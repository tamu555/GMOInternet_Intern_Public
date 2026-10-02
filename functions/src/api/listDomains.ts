/**
 * `listDomains` — the member-scoped domain list behind FIG.9.
 *
 * Reads only the Firestore mirror scoped to the caller's own uid; no live
 * registry call is made, so this Callable needs neither registry secrets nor
 * a raised timeout. The mirror query and the safe DTO projection are the
 * tenant boundary for this flow, and live entirely in
 * `domain/domainRepository.ts` — this handler only sequences auth, the
 * active-member gate, and the query.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {
  isActiveMember,
  listOwnedDomains,
  type DomainListItem,
} from "../domain/domainRepository";
import {toHttpsError} from "./httpsErrors";

/** `listDomains` accepts no parameters. */
export type ListDomainsData = Record<string, never>;

/** Response returned to the client. */
export interface ListDomainsResponse {
  domains: DomainListItem[];
}

/** Dependencies the handler needs, substitutable in tests. */
export interface ListDomainsHandlerDependencies {
  isActiveMember(uid: string): Promise<boolean>;
  listOwnedDomains(uid: string): Promise<DomainListItem[]>;
}

const defaultDependencies: ListDomainsHandlerDependencies = {
  isActiveMember,
  listOwnedDomains,
};

/**
 * Handles one `listDomains` invocation.
 *
 * Order is auth -> active-member gate -> mirror query, matching every other
 * protected Callable in this feature. Neither dependency here ever reaches
 * the registry.
 *
 * @param {CallableRequest<unknown>} request Callable request.
 * @param {ListDomainsHandlerDependencies} dependencies Injectable
 *   dependencies; defaults to the production Firestore-backed
 *   implementations.
 * @return {Promise<ListDomainsResponse>} The caller's own domains, sorted by
 *   name.
 */
export async function handleListDomains(
  request: CallableRequest<unknown>,
  dependencies: ListDomainsHandlerDependencies = defaultDependencies,
): Promise<ListDomainsResponse> {
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

    const domains = await dependencies.listOwnedDomains(uid);
    return {domains};
  } catch (error) {
    throw toHttpsError(error, "listDomains");
  }
}

export const listDomains = onCall(async (request) => {
  await requireActiveUser(request.auth);
  return handleListDomains(request);
});
