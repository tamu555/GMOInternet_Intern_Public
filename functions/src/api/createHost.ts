/**
 * `createHost` — the host-object lifecycle prerequisite `host:update` needs
 * to be meaningfully callable (feature brief's "Host-object lifecycle gap").
 *
 * Unlike the other three Callables, the target resource does not exist yet,
 * so this cannot reuse `assertOwnsHost`/`beginMutation` as-is: it reserves
 * `registryHosts/{uid}__{hostName}` as `creating` *inside* the same
 * transaction that re-verifies parent-domain ownership, strictly before any
 * registry call — the reservation is what makes "never resend a non-
 * idempotent POST" possible on replay. EPP `2302` is recorded as a
 * `conflict` lifecycle state and the pre-existing host is never adopted into
 * caller ownership.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS, type RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryClient} from "../bridge/registryClient";
import type {EppHostAddress} from "../bridge/types";
import {isRegistryError} from "../bridge/errors";
import {adhocClTrid} from "../domain/clTrid";
import {
  normaliseCreateHostData,
  type HostAddress,
} from "../domain/validation";
import {assertOwnsDomain, type OwnedHost} from "../domain/ownership";
import {
  markMutationDispatching,
  markMutationRejected,
  markRegistryAccepted,
  prepareMutation,
  reconcileHostMirror,
  type MutationLease,
  type OperationPhase,
  type RegistryProjection,
} from "../domain/updateMirrors";
import {ReconciliationRequiredError, toHttpsError} from "./httpsErrors";
import {
  computeRequestHash,
  isTerminalPhase,
  terminalReplayResult,
  type MutationResult,
} from "./updateCallableSupport";

/** Dependencies `makeCreateHostHandler` closes over, all overridable. */
export interface CreateHostDependencies {
  firestore?: Firestore;
  getClient?: (registry: RegistryId) => RegistryClient;
}

/** Handler function `onCall` accepts, as produced by the factory below. */
export type CreateHostHandler = (
  request: CallableRequest<unknown>,
) => Promise<MutationResult>;

/** Host lifecycle states that mean "already spoken for", pre-registry-call. */
const HOST_TAKEN_LIFECYCLE_STATES = [
  "creating",
  "ready",
  "reconciliationRequired",
] as const;

/**
 * @param {HostAddress[]} addresses Validated addresses.
 * @return {EppHostAddress[]} Wire-shaped addresses.
 */
function toWireAddresses(addresses: HostAddress[]): EppHostAddress[] {
  return addresses.map((a) => ({addr: a.ip, ip: a.version}));
}

/** Outcome of {@link reserveHost}. */
interface HostReservation {
  hostRef: DocumentReference;
  operationRef: DocumentReference;
  resumed: boolean;
  phase: OperationPhase;
  clTRID?: string;
  /** Only set on a resumed reservation; used to render a `conflict` replay
   * distinctly from a generic `failed` replay. */
  lifecycleState?: string;
}

/**
 * Reserves `registryHosts/{uid}__{hostName}` as `creating`, re-verifying
 * parent-domain ownership inside the same transaction. A prior `failed` or
 * `conflict` reservation for the same name may be retried with a fresh
 * `operationId`; a `creating`/`ready`/`reconciliationRequired` one may not.
 *
 * @param {Firestore} firestore Firestore handle.
 * @param {string} uid Caller uid.
 * @param {DocumentReference} parentDomainRef Ref of the caller-owned parent
 *   domain, from an already-performed `assertOwnsDomain` pre-check.
 * @param {string} parentDomainName Canonical parent domain name.
 * @param {RegistryId} registry Registry the parent domain (and thus the new
 *   host) belongs to.
 * @param {string} hostName Canonical host name to reserve.
 * @param {string} operationId Caller-supplied idempotency key.
 * @param {string} requestHash Stable hash of the normalised request body.
 * @return {Promise<HostReservation>} The reservation, fresh or resumed.
 */
async function reserveHost(
  firestore: Firestore,
  uid: string,
  parentDomainRef: DocumentReference,
  parentDomainName: string,
  registry: RegistryId,
  hostName: string,
  operationId: string,
  requestHash: string,
): Promise<HostReservation> {
  const hostRef = firestore
    .collection(COLLECTIONS.registryHosts)
    .doc(`${uid}__${hostName}`);
  const operationRef = hostRef.collection("operations").doc(operationId);

  return firestore.runTransaction(async (tx) => {
    const [domainSnap, hostSnap] = await Promise.all([
      tx.get(parentDomainRef),
      tx.get(hostRef),
    ]);

    const domainData = domainSnap.data();
    if (
      !domainData ||
      domainData.uid !== uid ||
      domainData.name !== parentDomainName
    ) {
      throw new HttpsError(
        "permission-denied",
        "対象のドメインが見つからないか、このアカウントの所有物ではありません。",
      );
    }

    const hostData = hostSnap.data();
    if (hostData) {
      const opSnap = await tx.get(operationRef);
      const opData = opSnap.data();
      if (opData) {
        if (opData.requestHash !== requestHash) {
          throw new HttpsError(
            "invalid-argument",
            "同一の operationId で内容の異なる要求が送信されました。",
          );
        }
        return {
          hostRef,
          operationRef,
          resumed: true,
          phase: opData.phase as OperationPhase,
          clTRID: opData.clTRID as string | undefined,
          lifecycleState: hostData.lifecycleState as string | undefined,
        };
      }
      const lifecycleState = hostData.lifecycleState as string | undefined;
      if (
        lifecycleState &&
        (HOST_TAKEN_LIFECYCLE_STATES as readonly string[]).includes(
          lifecycleState,
        )
      ) {
        throw new HttpsError(
          "aborted",
          "このホスト名は既に使用されています。",
        );
      }
      // "failed" or "conflict": fall through and re-reserve.
    }

    const now = FieldValue.serverTimestamp();
    tx.set(hostRef, {
      uid,
      name: hostName,
      parentDomain: parentDomainName,
      registry,
      lifecycleState: "creating",
      addresses: [],
      status: [],
      syncState: "updating",
      activeOperationId: operationId,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(operationRef, {
      uid,
      kind: "host",
      resourceKey: hostName,
      registry,
      command: "host:create",
      requestHash,
      phase: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return {hostRef, operationRef, resumed: false, phase: "reserved"};
  });
}

/**
 * Builds the `createHost` Callable handler.
 *
 * @param {CreateHostDependencies} dependencies Overridable collaborators.
 * @return {CreateHostHandler} Handler suitable for `onCall`.
 */
export function makeCreateHostHandler(
  dependencies: CreateHostDependencies = {},
): CreateHostHandler {
  const firestore = dependencies.firestore ?? db();
  const getClient = dependencies.getClient ?? getRegistryClient;

  return async (request: CallableRequest<unknown>): Promise<MutationResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const validated = normaliseCreateHostData(request.data);
      const parentDomain = await assertOwnsDomain(
        uid,
        validated.parentDomainName,
        firestore,
      );

      const requestHash = computeRequestHash({
        parentDomainName: validated.parentDomainName,
        hostName: validated.hostName,
        addresses: validated.addresses,
      });

      const reservation = await reserveHost(
        firestore,
        uid,
        parentDomain.ref,
        validated.parentDomainName,
        parentDomain.registry,
        validated.hostName,
        validated.operationId,
        requestHash,
      );

      const target: OwnedHost = {
        kind: "host",
        ref: reservation.hostRef,
        uid,
        name: validated.hostName,
        parentDomain: validated.parentDomainName,
        registry: parentDomain.registry,
      };
      const lease: MutationLease = {
        target,
        operationId: validated.operationId,
        operationRef: reservation.operationRef,
        command: "host:create",
        requestHash,
        resumed: reservation.resumed,
        phase: reservation.phase,
        clTRID: reservation.clTRID,
      };

      if (isTerminalPhase(lease.phase)) {
        return terminalReplayResult(lease, target.name, {
          notAppliedMessage:
            "作成内容は反映されませんでした。新しい operationId で再試行してください。",
          onRejected: () =>
            reservation.lifecycleState === "conflict" ?
              new HttpsError(
                "already-exists",
                "このホスト名は既に登録されています。",
              ) :
              undefined,
        });
      }

      const client = getClient(parentDomain.registry);
      let clTRID = lease.clTRID;

      if (lease.phase === "reserved") {
        const expected: RegistryProjection = {
          addresses: toWireAddresses(validated.addresses),
        };
        clTRID = adhocClTrid("CREATE", lease.operationId);
        await prepareMutation(lease, {}, expected, clTRID, firestore);
      }

      if (lease.phase === "reserved" || lease.phase === "prepared") {
        await markMutationDispatching(lease, firestore);
        try {
          await client.createHost(
            {
              name: validated.hostName,
              addrs: toWireAddresses(validated.addresses),
            },
            clTRID as string,
            {uid},
          );
        } catch (error) {
          if (isRegistryError(error) && error.kind === "objectExists") {
            await markMutationRejected(lease, firestore);
            await reservation.hostRef
              .set({lifecycleState: "conflict"}, {merge: true})
              .catch(() => undefined);
            throw error;
          }
          if (isRegistryError(error) && error.kind === "transport") {
            throw new ReconciliationRequiredError();
          }
          if (isRegistryError(error)) {
            await markMutationRejected(lease, firestore);
            await reservation.hostRef
              .set({lifecycleState: "failed"}, {merge: true})
              .catch(() => undefined);
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
        await reservation.hostRef
          .set({lifecycleState: "reconciliationRequired"}, {merge: true})
          .catch(() => undefined);
        throw new ReconciliationRequiredError();
      }
      if (decision === "applied") {
        await reservation.hostRef.set(
          {lifecycleState: "ready"},
          {merge: true},
        );
        return {
          operationId: lease.operationId,
          resourceName: target.name,
          state: "ready",
          recovered: lease.resumed,
        };
      }

      await reservation.hostRef
        .set({lifecycleState: "reconciliationRequired"}, {merge: true})
        .catch(() => undefined);
      throw new ReconciliationRequiredError();
    } catch (error) {
      throw toHttpsError(error, "createHost");
    }
  };
}

const createHostHandler = makeCreateHostHandler();

/** Production `createHost` Callable. */
export const createHost = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 90},
  async (request) => {
    await requireActiveUser(request.auth);
    return createHostHandler(request);
  },
);
