/**
 * Global runtime options, region pinning and secret declarations.
 *
 * Reference: docs/api-flow-diagrams.html FIG.2 / FIG.9,
 * docs/registrar-spec-draft.md 3.2 / 7.3.
 */
import {setGlobalOptions} from "firebase-functions";
import {defineSecret} from "firebase-functions/params";

/**
 * Firestore is provisioned in asia-northeast2 (firebase.json). Functions must
 * be pinned to the same region, otherwise every Admin SDK call pays a
 * cross-region round trip.
 */
export const REGION = "asia-northeast2";

setGlobalOptions({
  region: REGION,
  maxInstances: 10,
});

/** Registries this service talks to. */
export type RegistryId = "kitaqsign" | "kitaqnic";

/** All registries, in the order they should be probed at startup. */
export const REGISTRY_IDS: readonly RegistryId[] = [
  "kitaqsign",
  "kitaqnic",
] as const;

// Registry credentials. Never put these in environment variables or in the
// repository (spec 7.3). `firebase functions:secrets:set <NAME>` to populate.
//
// Authentication is two-layered: an outer Basic gate plus the per-request
// `X-Registrar-Id` / `X-Api-Key` headers. The gate and the registrar id are
// shared by both registries, so they are declared once; only the API key is
// issued per registry.
export const BASIC_GATE_USER = defineSecret("BASIC_GATE_USER");
export const BASIC_GATE_PASSWORD = defineSecret("BASIC_GATE_PASSWORD");
export const REGISTRAR_ID = defineSecret("REGISTRAR_ID");

export const KITAQSIGN_API_KEY = defineSecret("KITAQSIGN_API_KEY");
export const KITAQNIC_API_KEY = defineSecret("KITAQNIC_API_KEY");

/**
 * Secrets that every function touching a registry must declare in its
 * `secrets:` option, otherwise `.value()` returns an empty string at runtime.
 */
export const REGISTRY_SECRETS = [
  BASIC_GATE_USER,
  BASIC_GATE_PASSWORD,
  REGISTRAR_ID,
  KITAQSIGN_API_KEY,
  KITAQNIC_API_KEY,
];

/** Resolved connection settings for one registry. */
export interface RegistryCredentials {
  baseUrl: string;
  gateUser: string;
  gatePassword: string;
  registrarId: string;
  apiKey: string;
}

const DEFAULT_BASE_URLS: Record<RegistryId, string> = {
  kitaqsign: "https://epp.kitaqsign.com",
  kitaqnic: "https://epp.kitaqnic.com",
};

/**
 * Reads the credentials for one registry. Must be called inside a request
 * handler: `defineSecret(...).value()` is only populated at invocation time.
 *
 * @param {RegistryId} registry Registry to resolve.
 * @return {RegistryCredentials} Base URL and both authentication layers.
 */
export function resolveRegistryCredentials(
  registry: RegistryId,
): RegistryCredentials {
  const envBaseUrl = process.env[`${registry.toUpperCase()}_BASE_URL`];
  const baseUrl = envBaseUrl || DEFAULT_BASE_URLS[registry];

  return {
    baseUrl,
    gateUser: BASIC_GATE_USER.value(),
    gatePassword: BASIC_GATE_PASSWORD.value(),
    registrarId: REGISTRAR_ID.value(),
    apiKey: registry === "kitaqsign" ?
      KITAQSIGN_API_KEY.value() :
      KITAQNIC_API_KEY.value(),
  };
}

/** Default timeout for a single registry HTTP call, in milliseconds. */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 10_000;

/**
 * Timeout for a single registry HTTP call.
 *
 * Read per call rather than captured at import time so that tests can shorten
 * it; without that, the abort path could only be exercised by a test that
 * waits ten seconds, which means it would not be exercised at all.
 *
 * @return {number} Timeout in milliseconds.
 */
export function registryTimeoutMs(): number {
  const override = Number(process.env.REGISTRY_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ?
    override :
    DEFAULT_REGISTRY_TIMEOUT_MS;
}

/**
 * How many times a transport-level failure is retried inside one invocation.
 * Kept small so the outer Callable still answers well within its own timeout
 * (FIG.2: the fetch must time out before the function does).
 */
export const REGISTRY_MAX_ATTEMPTS = 3;
