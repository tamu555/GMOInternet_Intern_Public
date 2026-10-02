/**
 * `renewOrder` — the dedicated Callable for extending a domain's expiry
 * early, independent of the registry's own automatic yearly renewal.
 *
 * Deliberately a separate endpoint from `createOrder` rather than a `kind`
 * branch on it (design decision, `.agents/docs/DESIGN.md`). It mirrors
 * `createOrder`'s shape — auth, validation, price computed server-side, an
 * Order opened before any registry call, and a business outcome returned as
 * an Order state rather than thrown — but the ownership check and expiry
 * snapshot are specific to renew.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS, type RegistryId} from "../config/options";
import {openOrder, validateIdempotencyKey} from "../domain/orders";
import {priceForRenewal} from "../domain/pricing";
import {renewDomain} from "../domain/renewDomain";
import {
  expectedRenewalExDate,
  normaliseDomainName,
  normaliseEppDateTime,
  normalisePeriodYears,
  validateEppDate,
} from "../domain/validation";
import {toHttpsError} from "./httpsErrors";

/** Shape the React client sends. */
interface RenewOrderData {
  domainName?: string;
  periodYears?: number;
  idempotencyKey?: string;
}

/** Fields this Callable reads from the owned Domain document. */
interface OwnedDomainRecord {
  uid: string;
  name: string;
  registry: RegistryId;
  exDate?: string;
}

/**
 * Renews a domain: opens the order with an immutable expiry snapshot, then
 * runs `renewDomain()`.
 *
 * No registry status pre-flight and no `domain:info` round-trip happen here
 * (per the recorded design decision) — the registry's own rejection is
 * authoritative, and the timeout budget below is sized the same way
 * `createOrder`'s is, so a slow registry surfaces as `retrying` rather than a
 * dead invocation.
 */
export const renewOrder = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 120},
  async (request) => {
    await requireActiveUser(request.auth);
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const data = (request.data ?? {}) as RenewOrderData;

      const domainName = normaliseDomainName(String(data.domainName ?? ""));
      const periodYears = normalisePeriodYears(data.periodYears);
      const idempotencyKey = validateIdempotencyKey(
        String(data.idempotencyKey ?? ""),
      );

      const domainSnap = await db()
        .collection(COLLECTIONS.domains)
        .doc(`${uid}__${domainName}`)
        .get();
      if (!domainSnap.exists) {
        throw new HttpsError(
          "not-found",
          "対象のドメインが見つかりません。",
        );
      }
      const domain = domainSnap.data() as OwnedDomainRecord;
      if (domain.uid !== uid) {
        throw new HttpsError(
          "permission-denied",
          "このドメインを更新する権限がありません。",
        );
      }

      // Both registries' OpenAPI leave `exDate` out of the info response's
      // required set, so a mirror without one is contract-legal. Refuse it
      // as a precondition, not as the format-validation 400 below — that
      // wording would look identical to the (fixed) datetime-vs-date bug.
      if (!domain.exDate) {
        throw new HttpsError(
          "failed-precondition",
          "このドメインの有効期限を確認できないため更新できません。" +
            "時間をおいて再度お試しください。",
        );
      }

      // The mirror stores the registry's `exDate` verbatim, which the real
      // registries answer as an ISO datetime; the renew contract is
      // date-only, so truncate before the strict validation.
      const curExpDate = validateEppDate(
        normaliseEppDateTime(domain.exDate),
        "curExpDate",
      );
      const expectedExDate = expectedRenewalExDate(curExpDate, periodYears);

      const order = await openOrder({
        kind: "renew",
        uid,
        idempotencyKey,
        domainName,
        registry: domain.registry,
        periodYears,
        priceYen: priceForRenewal(domainName, periodYears),
        curExpDate,
        expectedExDate,
      });

      // A repeat submit must land on the same renew order, never a second
      // charge, and never silently reuse a key a `create` call already
      // claimed (guarded symmetrically on that side too).
      if (!order.isNew && order.data.kind !== "renew") {
        throw new HttpsError(
          "invalid-argument",
          "この idempotencyKey は create 用に使用済みです。",
        );
      }
      if (!order.isNew && order.data.domainName !== domainName) {
        throw new HttpsError(
          "invalid-argument",
          "この idempotencyKey は別のドメインで使用済みです。",
        );
      }
      if (
        !order.isNew &&
        (order.data.registry !== domain.registry ||
          order.data.periodYears !== periodYears)
      ) {
        throw new HttpsError(
          "invalid-argument",
          "この idempotencyKey は別の条件で使用済みです。",
        );
      }

      const result = await renewDomain(order);

      return {
        orderId: order.id,
        orderSeq: order.data.seq,
        priceYen: order.data.priceYen,
        ...result,
      };
    } catch (error) {
      throw toHttpsError(error, "renewOrder");
    }
  },
);
