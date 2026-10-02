/**
 * Kitaqnic client. 18 gTLDs, read from `hello` rather than hard-coded.
 *
 * Kitaqnic's `hello` is typed as an untyped map instead of Kitaqsign's
 * `GreetingResponse`, and the field holding the TLD list is not fixed by the
 * schema. Both spellings seen in the documentation are accepted, and the
 * normalised shape handed upwards is identical to Kitaqsign's.
 */
import {BaseRegistryClient, type Route} from "./registryClient";
import type {RegistryGreeting} from "./types";

/**
 * Reads a string array out of an untyped map, ignoring non-string entries.
 *
 * @param {Record<string, unknown> | undefined} data Raw `resData`.
 * @param {string[]} keys Candidate field names, in priority order.
 * @return {string[]} First non-empty list found, or an empty array.
 */
function pickStringArray(
  data: Record<string, unknown> | undefined,
  keys: string[],
): string[] {
  for (const key of keys) {
    const value = data?.[key];
    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string => typeof item === "string",
      );
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

/** RegistryClient bound to Kitaqnic. */
export class KitaqnicClient extends BaseRegistryClient {
  /** Creates a client for the Kitaqnic registry. */
  constructor() {
    super("kitaqnic");
  }

  /** @inheritdoc */
  async hello(clTRID: string): Promise<RegistryGreeting> {
    const answer = await this.http.send<Record<string, unknown>>({
      command: "session:hello",
      method: "GET",
      path: "/sessions/hello",
      clTRID,
      idempotent: true,
    });
    const data = answer.resData;
    // 実測 (2026-08-26, spec テスト1): the live answer nests everything under
    // `resData.info` — `info.supportedTlds` (18 entries, no leading dots) and
    // `info.registryCode` — unlike Kitaqsign's flat `resData.tlds`. Keep the
    // top-level lookups as well in case the shape changes back.
    const rawInfo = data?.["info"];
    const info =
      typeof rawInfo === "object" && rawInfo !== null ?
        (rawInfo as Record<string, unknown>) :
        undefined;
    const registryCode = data?.["registryCode"] ?? info?.["registryCode"];
    const message = data?.["message"] ?? info?.["message"];
    const tlds = pickStringArray(data, ["tlds", "supportedTlds"]);
    return {
      registry: this.registry,
      registryCode:
        typeof registryCode === "string" ? registryCode : undefined,
      tlds: tlds.length > 0 ?
        tlds :
        pickStringArray(info, ["supportedTlds", "tlds"]),
      message: typeof message === "string" ? message : undefined,
    };
  }

  /** @inheritdoc */
  protected pollRoute(): Route {
    return {method: "GET", path: "/messages"};
  }

  /** @inheritdoc */
  protected ackRoute(id: string): Route {
    return {
      method: "DELETE",
      path: `/messages/${encodeURIComponent(id)}`,
    };
  }
}
