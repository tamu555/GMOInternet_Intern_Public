/**
 * The watch Callables — 空き待ち通知 ("空いたらお知らせ") の境界.
 *
 * | Callable      | What it does                                |
 * |---------------|---------------------------------------------|
 * | `addWatch`    | registers a watch on one name               |
 * | `listWatches` | every watch of the caller's, newest first   |
 * | `cancelWatch` | drops one watch                             |
 *
 * Thin on purpose: authenticate, validate, hand over to domain/watches.ts,
 * translate whatever comes back. `addWatch` declares the registry secrets
 * because TLD routing may have to run `hello` to build its map; the other
 * two never leave Firestore, the same split `listTransfers` makes.
 *
 * Registering a watch deliberately does NOT check availability: the button
 * only appears on names that could not be bought (使用中 / メンテナンス中 /
 * 一時購入不可), and during a maintenance window a check could not run
 * anyway. The next sweep is the arbiter — a name that was actually free
 * simply flips to `available` on the first pass.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import {requireActiveUser} from "../auth/callerGuard";
import {REGISTRY_SECRETS} from "../config/options";
import {resolveRegistry} from "../bridge/registryRouter";
import {adhocClTrid} from "../domain/clTrid";
import {normaliseDomainName} from "../domain/validation";
import {
  MAX_ACTIVE_WATCHES,
  addWatch as addWatchCase,
  cancelWatch as cancelWatchCase,
  listWatches as listWatchesCase,
} from "../domain/watches";
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

/** 空き待ちの登録. Re-registering an already watched name is not an error. */
export const addWatch = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 60},
  async (request) => {
    await requireActiveUser(request.auth);
    const uid = requireUid(request.auth);
    try {
      const data = (request.data ?? {}) as Record<string, unknown>;
      const domainName = normaliseDomainName(String(data.domainName ?? ""));

      const registry = await resolveRegistry(
        domainName,
        adhocClTrid("WATCH-ROUTE", uid.slice(0, 12)),
      );
      if (!registry) {
        throw new HttpsError(
          "invalid-argument",
          "このTLDは取り扱っていません。",
        );
      }

      const added = await addWatchCase(uid, domainName, registry);
      if (added.outcome === "limit") {
        throw new HttpsError(
          "failed-precondition",
          `空き待ちに登録できるのは${MAX_ACTIVE_WATCHES}件までです。` +
          "マイページで不要な空き待ちを解除してからお試しください。",
        );
      }
      return {
        watch: added.watch,
        alreadyWatching: added.outcome === "already",
      };
    } catch (error) {
      throw toHttpsError(error, "addWatch");
    }
  },
);

/** Every watch of the caller's, cancelled ones omitted. */
export const listWatches = onCall(async (request) => {
  await requireActiveUser(request.auth);
  const uid = requireUid(request.auth);
  try {
    return {watches: await listWatchesCase(uid)};
  } catch (error) {
    throw toHttpsError(error, "listWatches");
  }
});

/** 空き待ちの解除. */
export const cancelWatch = onCall(async (request) => {
  await requireActiveUser(request.auth);
  const uid = requireUid(request.auth);
  try {
    const data = (request.data ?? {}) as Record<string, unknown>;
    const domainName = normaliseDomainName(String(data.domainName ?? ""));
    const cancelled = await cancelWatchCase(uid, domainName);
    if (!cancelled) {
      throw new HttpsError(
        "not-found",
        "このドメインの空き待ちは登録されていません。",
      );
    }
    return {ok: true};
  } catch (error) {
    throw toHttpsError(error, "cancelWatch");
  }
});
