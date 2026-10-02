/**
 * `updateHost` — `host:update` (address add/remove only) for a caller-owned
 * host. Rename is out of scope for this feature; host name/parent/registry
 * never change here.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import type {Firestore} from "firebase-admin/firestore";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS, type RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryClient} from "../bridge/registryClient";
import type {
  EppHostAddress,
  HostInfo,
  HostUpdateRequest,
} from "../bridge/types";
import {isRegistryError} from "../bridge/errors";
import {adhocClTrid} from "../domain/clTrid";
import {
  normaliseUpdateHostData,
  type HostAddress,
  type ValidatedHostUpdate,
} from "../domain/validation";
import {assertOwnsHost, type OwnedHost} from "../domain/ownership";
import {
  beginMutation,
  markMutationDispatching,
  markMutationRejected,
  markRegistryAccepted,
  prepareMutation,
  reconcileHostMirror,
  type RegistryProjection,
} from "../domain/updateMirrors";
import {ReconciliationRequiredError, toHttpsError} from "./httpsErrors";
import {
  assertOwnsOrResumeOwnOperation,
  computeRequestHash,
  isRegistryId,
  isTerminalPhase,
  projectionsEqual,
  terminalReplayResult,
  type MutationResult,
} from "./updateCallableSupport";

/** Dependencies `makeUpdateHostHandler` closes over, all overridable. */
export interface UpdateHostDependencies {
  firestore?: Firestore;
  getClient?: (registry: RegistryId) => RegistryClient;
}

/** Handler function `onCall` accepts, as produced by the factory below. */
export type UpdateHostHandler = (
  request: CallableRequest<unknown>,
) => Promise<MutationResult>;

/**
 * `assertOwnsHost`, tolerating a same-operationId resume of an in-flight
 * mutation. See `updateCallableSupport.ts`'s `assertOwnsOrResumeOwnOperation`
 * for the shared rationale/mechanics.
 *
 * @param {string} uid Caller uid.
 * @param {string} name Canonical host name.
 * @param {string} operationId Idempotency key on the current request.
 * @param {Firestore} firestore Firestore handle.
 * @return {Promise<OwnedHost>} The owned host, resumed or fresh.
 */
function assertOwnsHostOrResumeOwnOperation(
  uid: string,
  name: string,
  operationId: string,
  firestore: Firestore,
): Promise<OwnedHost> {
  const ref = firestore
    .collection(COLLECTIONS.registryHosts)
    .doc(`${uid}__${name}`);
  return assertOwnsOrResumeOwnOperation(
    () => assertOwnsHost(uid, name, firestore),
    ref,
    operationId,
    (data) => {
      if (
        data.uid !== uid ||
        data.name !== name ||
        typeof data.parentDomain !== "string" ||
        !isRegistryId(data.registry)
      ) {
        return undefined;
      }
      return {
        kind: "host",
        ref,
        uid,
        name,
        parentDomain: data.parentDomain,
        registry: data.registry,
      };
    },
  );
}

/**
 * @param {HostAddress[]} addresses Validated addresses.
 * @return {EppHostAddress[]} Wire-shaped addresses.
 */
function toWireAddresses(addresses: HostAddress[]): EppHostAddress[] {
  return addresses.map((a) => ({addr: a.ip, ip: a.version}));
}

/**
 * Applies add/remove to the current address set. Matched by IP value only
 * (case-insensitive): `normaliseHostAddresses` already assigns the wire IP
 * version deterministically via `net.isIP()`, so no two entries can share an
 * IP with different versions.
 *
 * @param {EppHostAddress[]} current Addresses from `host:info`.
 * @param {ValidatedHostUpdate} validated Validated `updateHost` input.
 * @return {EppHostAddress[]} Expected address set after the mutation.
 */
function computeExpectedAddresses(
  current: EppHostAddress[],
  validated: ValidatedHostUpdate,
): EppHostAddress[] {
  const byIp = new Map<string, EppHostAddress>();
  for (const addr of current) byIp.set(addr.addr.toLowerCase(), addr);
  for (const addr of validated.remove?.addresses ?? []) {
    byIp.delete(addr.ip.toLowerCase());
  }
  for (const addr of validated.add?.addresses ?? []) {
    byIp.set(addr.ip.toLowerCase(), {addr: addr.ip, ip: addr.version});
  }
  return [...byIp.values()];
}

/**
 * Builds the `updateHost` Callable handler.
 *
 * @param {UpdateHostDependencies} dependencies Overridable collaborators.
 * @return {UpdateHostHandler} Handler suitable for `onCall`.
 */
export function makeUpdateHostHandler(
  dependencies: UpdateHostDependencies = {},
): UpdateHostHandler {
  const firestore = dependencies.firestore ?? db();
  const getClient = dependencies.getClient ?? getRegistryClient;

  return async (request: CallableRequest<unknown>): Promise<MutationResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const validated = normaliseUpdateHostData(request.data);
      const target = await assertOwnsHostOrResumeOwnOperation(
        uid,
        validated.hostName,
        validated.operationId,
        firestore,
      );

      const client = getClient(target.registry);
      const requestHash = computeRequestHash({
        hostName: validated.hostName,
        add: validated.add,
        remove: validated.remove,
      });

      const lease = await beginMutation(
        target,
        validated.operationId,
        "host:update",
        requestHash,
        firestore,
      );

      if (isTerminalPhase(lease.phase)) {
        return terminalReplayResult(lease, target.name);
      }

      let clTRID = lease.clTRID;

      if (lease.phase === "reserved") {
        const preInfo: HostInfo = await client.infoHost(
          target.name,
          adhocClTrid("INFO", `${lease.operationId}-pre`),
        );
        const expectedAddresses = computeExpectedAddresses(
          preInfo.addresses,
          validated,
        );
        const before: RegistryProjection = {addresses: preInfo.addresses};
        const expected: RegistryProjection = {addresses: expectedAddresses};
        if (projectionsEqual(before, expected)) {
          await markMutationRejected(lease, firestore);
          throw new HttpsError(
            "failed-precondition",
            "現在のレジストリの状態と比較して変更内容がありません。",
          );
        }
        clTRID = adhocClTrid("UPDATE", lease.operationId);
        await prepareMutation(lease, before, expected, clTRID, firestore);
      }

      if (lease.phase === "reserved" || lease.phase === "prepared") {
        await markMutationDispatching(lease, firestore);
        const wireRequest: HostUpdateRequest = {};
        if (validated.add) {
          wireRequest.add = {
            addrs: toWireAddresses(validated.add.addresses),
          };
        }
        if (validated.remove) {
          wireRequest.rem = {
            addrs: toWireAddresses(validated.remove.addresses),
          };
        }
        try {
          await client.updateHost(
            target.name,
            wireRequest,
            clTRID as string,
            {uid},
          );
        } catch (error) {
          if (isRegistryError(error) && error.kind === "transport") {
            throw new ReconciliationRequiredError();
          }
          if (isRegistryError(error)) {
            await markMutationRejected(lease, firestore);
          }
          throw error;
        }
        await markRegistryAccepted(lease, firestore);
      } else if (lease.phase === "dispatching") {
        await markRegistryAccepted(lease, firestore);
      }

      let decision;
      try {
        decision = await reconcileHostMirror(lease, client, firestore);
      } catch {
        throw new ReconciliationRequiredError();
      }
      if (decision !== "applied") {
        throw new ReconciliationRequiredError();
      }

      return {
        operationId: lease.operationId,
        resourceName: target.name,
        state: "ready",
        recovered: lease.resumed,
      };
    } catch (error) {
      throw toHttpsError(error, "updateHost");
    }
  };
}

const updateHostHandler = makeUpdateHostHandler();

/** Production `updateHost` Callable. */
export const updateHost = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 90},
  async (request) => {
    await requireActiveUser(request.auth);
    return updateHostHandler(request);
  },
);
