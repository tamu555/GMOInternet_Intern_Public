/**
 * `searchDomains` — the arrow out of the search screen in FIG.1.
 *
 * Fans `domain:check` out to whichever registry serves each TLD and returns
 * one merged list. The TLD split is invisible to the client on purpose: that
 * is the whole point of the routing table (spec 4.3).
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {REGISTRY_SECRETS} from "../config/options";
import {isRegistryError} from "../bridge/errors";
import {getRegistryClient, groupByRegistry} from "../bridge/registryRouter";
import {adhocClTrid} from "../domain/clTrid";
import {normaliseDomainName} from "../domain/validation";
import type {DomainAvailability} from "../bridge/types";
import {toHttpsError} from "./httpsErrors";

/** Upper bound on names per request, to keep one call cheap. */
const MAX_NAMES = 25;

/**
 * Availability search across both registries.
 *
 * Deliberately callable without sign-in, like `listTlds`: the search screen
 * is public (`AppRouter.tsx` — "searching, availability, pricing and
 * suggestions never require a login"), and sign-in is what buying requires,
 * not what looking requires. The registry credentials still never leave the
 * server — this endpoint exposes the *answer* to `domain:check`, never the
 * ability to issue arbitrary commands, and `MAX_NAMES` caps how much one
 * call can ask for.
 *
 * This used to demand `request.auth`, which contradicted the screen it
 * serves: an anonymous visitor got a generic "時間をおいて再度お試しくださ
 * い。" on every search. That is the contradiction being removed here, not a
 * gate being weakened.
 *
 * Unlike `listTlds`, an answer here is not cached, so anonymous traffic does
 * reach the registry. Rate limiting therefore belongs in front of this
 * Callable (App Check or an equivalent) before the site is exposed publicly.
 */
export const searchDomains = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 60},
  async (request) => {
    try {
      const rawNames = (request.data?.names ?? []) as unknown[];
      if (!Array.isArray(rawNames) || rawNames.length === 0) {
        throw new HttpsError("invalid-argument", "names が空です。");
      }
      if (rawNames.length > MAX_NAMES) {
        throw new HttpsError(
          "invalid-argument",
          `一度に検索できるのは${MAX_NAMES}件までです。`,
        );
      }

      const names = rawNames.map((name) =>
        normaliseDomainName(String(name)),
      );
      // The uid only labels the registry log line; an anonymous search is a
      // legitimate caller here, not a missing one.
      const clTRID = adhocClTrid(
        "SEARCH",
        request.auth?.uid.slice(0, 12) ?? "anon",
      );
      const {grouped, unsupported} = await groupByRegistry(names, clTRID);

      // One registry must never take the other down with it (partial
      // degradation, docs/仕様/registry-unavailable.md §5.1). Names of a
      // registry inside an ANNOUNCED maintenance window are reported as
      // `maintenance`; names of a registry JUDGED unreachable (503s sustained
      // ~1min, circuit open) are reported as `unavailable`; any other failure
      // — a fresh 503 included — simply leaves its names unanswered, which
      // the client renders as the honest 3rd state (§6.7). The stronger claim
      // needs the stronger proof.
      const groups = [...grouped.entries()];
      const answers = await Promise.allSettled(
        groups.map(([registry, group]) =>
          getRegistryClient(registry).checkDomains(
            group,
            `${clTRID}-${registry}`.slice(0, 64),
          ),
        ),
      );

      const results: DomainAvailability[] = [];
      const unavailable: string[] = [];
      const maintenance: string[] = [];
      let maintenanceUntil: string | null = null;
      answers.forEach((answer, index) => {
        const [registry, group] = groups[index];
        if (answer.status === "fulfilled") {
          results.push(...answer.value);
          return;
        }
        if (isRegistryError(answer.reason) && answer.reason.maintenance) {
          maintenance.push(...group);
          maintenanceUntil ??= answer.reason.maintenanceUntil;
          return;
        }
        if (isRegistryError(answer.reason) && answer.reason.circuitOpen) {
          unavailable.push(...group);
          return;
        }
        logger.error("searchDomains: one registry failed", {
          registry,
          error: isRegistryError(answer.reason) ?
            answer.reason.toLogPayload() :
            String(answer.reason),
        });
      });

      // Partial degradation only goes so far: when not a single name got an
      // answer (and none is explained by an open circuit or an announced
      // window), an all-"unknown" table would hide that the search itself
      // failed — keep the error path.
      const firstFailure = answers.find(
        (answer) => answer.status === "rejected",
      );
      if (results.length === 0 && unavailable.length === 0 &&
        maintenance.length === 0 && firstFailure?.status === "rejected") {
        throw firstFailure.reason;
      }

      return {
        results,
        unsupported,
        unavailable,
        maintenance,
        maintenanceUntil,
      };
    } catch (error) {
      throw toHttpsError(error, "searchDomains");
    }
  },
);
