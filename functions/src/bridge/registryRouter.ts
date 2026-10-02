/**
 * TLD routing (spec 4.3).
 *
 * The map from TLD to registry is built by calling `session:hello` on both
 * registries and reading the TLD list back. It is never hard-coded, which is
 * what lets the service pick up a registry-side TLD change without a deploy.
 *
 * Three layers of caching, in order: process memory, a Firestore mirror, and
 * finally the static fallback below. The fallback exists so that a registry
 * outage degrades search instead of breaking it; it is deliberately minimal
 * and is logged loudly whenever it is used.
 */
import * as logger from "firebase-functions/logger";
import {FieldValue} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_IDS, type RegistryId} from "../config/options";
import {KitaqnicClient} from "./kitaqnicClient";
import {KitaqsignClient} from "./kitaqsignClient";
import type {RegistryClient} from "./registryClient";

/** Mapping from a bare TLD label to the registry that serves it. */
export type TldMap = Record<string, RegistryId>;

/**
 * Known TLDs used only when both `hello` and the mirror are unavailable.
 *
 * The full 22 TLDs measured on 2026-08-26 (spec 3.8): a registry outage must
 * not make its TLDs vanish from the search screen
 * (docs/仕様/registry-unavailable.md §5.4), and while it lasts `hello`
 * answers 503, so this last resort has to cover both registries.
 *
 * 2026-08-27 16:00 registry-side change: `.org` / `.info` moved from
 * Kitaqsign to Kitaqnic (data carried over registry-side; Kitaqsign now
 * answers 2306 for them and dropped them from `hello`). Kitaqsign serves
 * `.com` / `.net` only.
 */
const FALLBACK_TLD_MAP: TldMap = {
  com: "kitaqsign",
  net: "kitaqsign",
  org: "kitaqnic",
  info: "kitaqnic",
  xyz: "kitaqnic",
  online: "kitaqnic",
  site: "kitaqnic",
  tech: "kitaqnic",
  space: "kitaqnic",
  store: "kitaqnic",
  website: "kitaqnic",
  press: "kitaqnic",
  host: "kitaqnic",
  fun: "kitaqnic",
  icu: "kitaqnic",
  cyou: "kitaqnic",
  sbs: "kitaqnic",
  bond: "kitaqnic",
  cfd: "kitaqnic",
  art: "kitaqnic",
  build: "kitaqnic",
  ceo: "kitaqnic",
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const MIRROR_DOC = "tldMap";

const clients: Partial<Record<RegistryId, RegistryClient>> = {};

let cachedMap: TldMap | undefined;
let cachedAt = 0;

/**
 * Returns the client for one registry, creating it on first use.
 *
 * @param {RegistryId} registry Registry to talk to.
 * @return {RegistryClient} Cached client instance.
 */
export function getRegistryClient(registry: RegistryId): RegistryClient {
  let client = clients[registry];
  if (!client) {
    client = registry === "kitaqsign" ?
      new KitaqsignClient() :
      new KitaqnicClient();
    clients[registry] = client;
  }
  return client;
}

/**
 * Normalises a domain name to its TLD label.
 *
 * @param {string} domainName FQDN, e.g. `example.com`.
 * @return {string} Lower-cased TLD without the leading dot.
 */
export function tldOf(domainName: string): string {
  const parts = domainName.toLowerCase().trim().split(".");
  return parts[parts.length - 1] ?? "";
}

/**
 * Builds the TLD map by asking both registries, and mirrors it to Firestore.
 *
 * @param {string} clTRID Transaction id prefix for the two hello calls.
 * @return {Promise<TldMap>} TLD to registry.
 */
async function buildTldMap(clTRID: string): Promise<TldMap> {
  const greetings = await Promise.allSettled(
    REGISTRY_IDS.map((registry) =>
      getRegistryClient(registry).hello(`${clTRID}-${registry}`),
    ),
  );

  const map: TldMap = {};
  let anySucceeded = false;
  const failedRegistries: RegistryId[] = [];

  greetings.forEach((outcome, index) => {
    const registry = REGISTRY_IDS[index];
    if (outcome.status === "rejected") {
      logger.error("session:hello failed", {registry, error: outcome.reason});
      failedRegistries.push(registry);
      return;
    }
    anySucceeded = true;
    for (const rawTld of outcome.value.tlds) {
      const tld = rawTld.replace(/^\./, "").toLowerCase();
      if (!tld) continue;
      if (map[tld] && map[tld] !== registry) {
        // Spec 4.3 leaves the tie-break open. Keeping the first registry in
        // REGISTRY_IDS order makes routing deterministic; surface it so the
        // team can decide deliberately rather than by accident.
        logger.warn("TLD served by both registries, keeping first", {
          tld,
          kept: map[tld],
          ignored: registry,
        });
        continue;
      }
      map[tld] = registry;
    }
  });

  if (!anySucceeded) {
    throw new Error("session:hello failed on every registry");
  }

  // A registry whose hello failed (e.g. a 503 outage) must not have its TLDs
  // vanish from the search screen (docs/仕様/registry-unavailable.md §5.4).
  // Without this, a PARTIAL hello success would build a shrunken map and
  // mirror it — silently overwriting the last full map. Keep the failed
  // registry's entries from the previous map; the next successful hello
  // refreshes them for real.
  if (failedRegistries.length > 0) {
    const previous = cachedMap ?? await readMirror();
    for (const registry of failedRegistries) {
      // Last known good first; the measured static list only when there is
      // nothing to inherit (fresh process AND empty mirror — e.g. right
      // after the emulator's data was reset). Without this second source,
      // one 503 from a registry at that moment builds a shrunken map, and
      // mirroring it makes the shrinkage stick until a hello succeeds.
      const inherited = Object.entries(previous ?? {})
        .filter(([, owner]) => owner === registry);
      const source = inherited.length > 0 ?
        inherited :
        Object.entries(FALLBACK_TLD_MAP)
          .filter(([, owner]) => owner === registry);
      for (const [tld] of source) {
        if (!map[tld]) map[tld] = registry;
      }
      logger.warn("kept TLDs of an unreachable registry", {
        registry,
        source: inherited.length > 0 ? "previous-map" : "static-fallback",
        tlds: source.length,
      });
    }
  }

  await db()
    .collection(COLLECTIONS.counters)
    .doc(MIRROR_DOC)
    .set({map, updatedAt: FieldValue.serverTimestamp()})
    .catch((error) => logger.error("failed to mirror TLD map", {error}));

  return map;
}

/**
 * Reads the Firestore mirror of the last successful TLD map.
 *
 * @return {Promise<TldMap | undefined>} Mirrored map.
 */
async function readMirror(): Promise<TldMap | undefined> {
  try {
    const snapshot = await db()
      .collection(COLLECTIONS.counters)
      .doc(MIRROR_DOC)
      .get();
    const map = snapshot.data()?.map as TldMap | undefined;
    return map && Object.keys(map).length > 0 ? map : undefined;
  } catch (error) {
    logger.error("failed to read mirrored TLD map", {error});
    return undefined;
  }
}

/**
 * Returns the TLD map, refreshing it when the in-process cache is stale.
 *
 * @param {string} clTRID Transaction id prefix for the hello calls.
 * @return {Promise<TldMap>} TLD to registry.
 */
export async function getTldMap(clTRID: string): Promise<TldMap> {
  const fresh = cachedMap && Date.now() - cachedAt < CACHE_TTL_MS;
  if (fresh && cachedMap) return cachedMap;

  try {
    cachedMap = await buildTldMap(clTRID);
    cachedAt = Date.now();
    return cachedMap;
  } catch (error) {
    logger.error("could not refresh TLD map from hello", {error});
  }

  const mirrored = await readMirror();
  if (mirrored) {
    logger.warn("using mirrored TLD map");
    cachedMap = mirrored;
    cachedAt = Date.now();
    return mirrored;
  }

  logger.error("using static fallback TLD map");
  return FALLBACK_TLD_MAP;
}

/**
 * Resolves which registry owns a domain name.
 *
 * @param {string} domainName FQDN to route.
 * @param {string} clTRID Transaction id prefix for a map refresh.
 * @return {Promise<RegistryId | undefined>} Registry, or undefined when the
 *   TLD is not served by either registry.
 */
export async function resolveRegistry(
  domainName: string,
  clTRID: string,
): Promise<RegistryId | undefined> {
  const map = await getTldMap(clTRID);
  return map[tldOf(domainName)];
}

/** Names bucketed per registry, plus the ones no registry serves. */
export interface GroupedNames {
  grouped: Map<RegistryId, string[]>;
  unsupported: string[];
}

/**
 * Groups names by the registry that serves them, so `domain:check` can be
 * fanned out with one request per registry.
 *
 * @param {string[]} names Domain names to route.
 * @param {string} clTRID Transaction id prefix for a map refresh.
 * @return {Promise<GroupedNames>} Grouped names and unsupported ones.
 */
export async function groupByRegistry(
  names: string[],
  clTRID: string,
): Promise<GroupedNames> {
  const map = await getTldMap(clTRID);
  const grouped = new Map<RegistryId, string[]>();
  const unsupported: string[] = [];

  for (const name of names) {
    const registry = map[tldOf(name)];
    if (!registry) {
      unsupported.push(name);
      continue;
    }
    const bucket = grouped.get(registry) ?? [];
    bucket.push(name);
    grouped.set(registry, bucket);
  }
  return {grouped, unsupported};
}

/** Clears the in-process cache. Test helper. */
export function resetTldCache(): void {
  cachedMap = undefined;
  cachedAt = 0;
}
