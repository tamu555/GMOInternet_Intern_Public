/**
 * `listTlds` — the TLD list the search screen renders before any input.
 *
 * Serves the routing map built from both registries' `session:hello`
 * (spec 4.3), so the screen shows exactly the TLDs a search can answer for,
 * without hard-coding them in the frontend.
 *
 * Deliberately callable without sign-in: the search screen is public
 * ("検索はログインなしで使えます"), and the response is a list of public
 * facts. The registry credentials stay server-side — this endpoint exposes
 * the *result* of hello, never the ability to issue commands. The map is
 * cached in-process and mirrored in Firestore, so anonymous traffic does not
 * translate into registry calls.
 */
import {onCall} from "firebase-functions/v2/https";
import {REGISTRY_SECRETS} from "../config/options";
import {getTldMap} from "../bridge/registryRouter";
import {adhocClTrid} from "../domain/clTrid";
import {toHttpsError} from "./httpsErrors";

/**
 * Returns the supported TLDs, sorted, as `{tlds: string[]}`.
 *
 * Leading-dot form (".com"): the search screen concatenates label + tld
 * verbatim (frontend/src/api/domainsSearchApi.ts documents the contract), so
 * a bare "com" would produce "labelcom" and fail validation.
 */
export const listTlds = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 60},
  async () => {
    try {
      const map = await getTldMap(adhocClTrid("TLDS", "list"));
      return {tlds: Object.keys(map).sort().map((tld) => `.${tld}`)};
    } catch (error) {
      throw toHttpsError(error, "listTlds");
    }
  },
);
