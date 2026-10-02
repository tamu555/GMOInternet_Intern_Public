/**
 * `updateContact` — `contact:update` for a caller-owned contact, routed via
 * the registry of a caller-owned `contextDomainName`.
 *
 * Registry may require a full-object PUT (spec 3.9 gives no body shape), so
 * this Callable always rebuilds the complete wire object from a pre-update
 * `contact:info` read plus only the explicitly changed fields — never a
 * partial merge sent as a full object.
 */
import {onCall, HttpsError} from "firebase-functions/v2/https";
import type {CallableRequest} from "firebase-functions/v2/https";
import type {Firestore} from "firebase-admin/firestore";
import {requireActiveUser} from "../auth/callerGuard";
import {COLLECTIONS, db} from "../config/firebase";
import {REGISTRY_SECRETS, type RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import type {RegistryClient} from "../bridge/registryClient";
import type {ContactChangeSet, ContactInfo} from "../bridge/types";
import {isRegistryError} from "../bridge/errors";
import {adhocClTrid} from "../domain/clTrid";
import {
  normaliseUpdateContactData,
  type ValidatedContactUpdate,
} from "../domain/validation";
import {
  assertOwnsContact,
  assertOwnsDomain,
  type OwnedContact,
} from "../domain/ownership";
import {
  beginMutation,
  markMutationDispatching,
  markMutationRejected,
  markRegistryAccepted,
  prepareMutation,
  reconcileContactMirror,
  type RegistryProjection,
} from "../domain/updateMirrors";
import {ReconciliationRequiredError, toHttpsError} from "./httpsErrors";
import {
  assertOwnsOrResumeOwnOperation,
  computeRequestHash,
  isTerminalPhase,
  projectionsEqual,
  terminalReplayResult,
  type MutationResult,
} from "./updateCallableSupport";

/** Dependencies `makeUpdateContactHandler` closes over, all overridable. */
export interface UpdateContactDependencies {
  firestore?: Firestore;
  getClient?: (registry: RegistryId) => RegistryClient;
}

/** Handler function `onCall` accepts, as produced by the factory below. */
export type UpdateContactHandler = (
  request: CallableRequest<unknown>,
) => Promise<MutationResult>;

/**
 * `assertOwnsContact`, tolerating a same-operationId resume of an in-flight
 * mutation. See `updateCallableSupport.ts`'s `assertOwnsOrResumeOwnOperation`
 * for the shared rationale/mechanics.
 *
 * @param {string} uid Caller uid.
 * @param {string} contactId Contact id the caller claims to own.
 * @param {RegistryId} requiredRegistry Registry resolved server-side.
 * @param {string} operationId Idempotency key on the current request.
 * @param {Firestore} firestore Firestore handle.
 * @return {Promise<OwnedContact>} The owned contact, resumed or fresh.
 */
function assertOwnsContactOrResumeOwnOperation(
  uid: string,
  contactId: string,
  requiredRegistry: RegistryId,
  operationId: string,
  firestore: Firestore,
): Promise<OwnedContact> {
  const ref = firestore
    .collection(COLLECTIONS.registryContacts)
    .doc(`${uid}__${requiredRegistry}`);
  return assertOwnsOrResumeOwnOperation(
    () => assertOwnsContact(uid, contactId, requiredRegistry, firestore),
    ref,
    operationId,
    (data) => {
      if (
        data.uid !== uid ||
        data.contactId !== contactId ||
        data.registry !== requiredRegistry
      ) {
        return undefined;
      }
      return {
        kind: "contact",
        ref,
        uid,
        contactId,
        registry: requiredRegistry,
      };
    },
  );
}

/** Validated `change` block of `updateContact`. */
type ContactChangeInput = ValidatedContactUpdate["change"];

/**
 * Rebuilds the full `contact:update` `chg` object from a pre-update
 * `contact:info` read plus the explicitly changed fields.
 *
 * @param {ContactInfo} pre Pre-mutation `contact:info` answer.
 * @param {ContactChangeInput} change Validated changed fields.
 * @return {ContactChangeSet} Full wire `chg` object.
 */
function buildContactChangeSet(
  pre: ContactInfo,
  change: ContactChangeInput,
): ContactChangeSet {
  const chg: ContactChangeSet = {
    postalInfo: {
      ...pre.postalInfo,
      name: change.name ?? pre.postalInfo.name,
    },
    email: change.email ?? pre.email,
  };
  const voice = change.voice ?? pre.voice;
  const fax = change.fax ?? pre.fax;
  if (voice !== undefined) chg.voice = voice;
  if (fax !== undefined) chg.fax = fax;
  return chg;
}

/**
 * @param {ContactInfo} pre Pre-mutation `contact:info` answer.
 * @param {ContactChangeSet} chg Full wire `chg` object built for the PUT.
 * @return {{before: RegistryProjection, expected: RegistryProjection}}
 *   Before/expected projections for reconciliation.
 */
function computeProjections(
  pre: ContactInfo,
  chg: ContactChangeSet,
): {before: RegistryProjection; expected: RegistryProjection} {
  const before: RegistryProjection = {
    postalInfo: pre.postalInfo,
    email: pre.email,
  };
  const expected: RegistryProjection = {
    postalInfo: chg.postalInfo,
    email: chg.email,
  };
  if (pre.voice !== undefined || chg.voice !== undefined) {
    before.voice = pre.voice ?? null;
    expected.voice = chg.voice ?? null;
  }
  if (pre.fax !== undefined || chg.fax !== undefined) {
    before.fax = pre.fax ?? null;
    expected.fax = chg.fax ?? null;
  }
  return {before, expected};
}

/**
 * Builds the `updateContact` Callable handler.
 *
 * @param {UpdateContactDependencies} dependencies Overridable collaborators.
 * @return {UpdateContactHandler} Handler suitable for `onCall`.
 */
export function makeUpdateContactHandler(
  dependencies: UpdateContactDependencies = {},
): UpdateContactHandler {
  const firestore = dependencies.firestore ?? db();
  const getClient = dependencies.getClient ?? getRegistryClient;

  return async (request: CallableRequest<unknown>): Promise<MutationResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const validated = normaliseUpdateContactData(request.data);
      const contextDomain = await assertOwnsDomain(
        uid,
        validated.contextDomainName,
        firestore,
      );
      const target = await assertOwnsContactOrResumeOwnOperation(
        uid,
        validated.contactId,
        contextDomain.registry,
        validated.operationId,
        firestore,
      );

      const client = getClient(target.registry);
      const requestHash = computeRequestHash({
        contactId: validated.contactId,
        contextDomainName: validated.contextDomainName,
        change: validated.change,
      });

      const lease = await beginMutation(
        target,
        validated.operationId,
        "contact:update",
        requestHash,
        firestore,
      );

      if (isTerminalPhase(lease.phase)) {
        return terminalReplayResult(lease, target.contactId);
      }

      let clTRID = lease.clTRID;
      let chg: ContactChangeSet | undefined;

      if (lease.phase === "reserved") {
        const preInfo = await client.infoContact(
          target.contactId,
          adhocClTrid("INFO", `${lease.operationId}-pre`),
        );
        chg = buildContactChangeSet(preInfo, validated.change);
        const {before, expected} = computeProjections(preInfo, chg);
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
        if (!chg) {
          // Resumed from a `prepared` lease written by an earlier
          // invocation: rebuild the same full object from a fresh
          // `contact:info` read rather than trusting stale state.
          const preInfo = await client.infoContact(
            target.contactId,
            adhocClTrid("INFO", `${lease.operationId}-resume`),
          );
          chg = buildContactChangeSet(preInfo, validated.change);
        }
        try {
          await client.updateContact(
            target.contactId,
            {chg},
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
        decision = await reconcileContactMirror(lease, client, firestore);
      } catch {
        throw new ReconciliationRequiredError();
      }
      if (decision !== "applied") {
        throw new ReconciliationRequiredError();
      }

      return {
        operationId: lease.operationId,
        resourceName: target.contactId,
        state: "ready",
        recovered: lease.resumed,
      };
    } catch (error) {
      throw toHttpsError(error, "updateContact");
    }
  };
}

const updateContactHandler = makeUpdateContactHandler();

/** Production `updateContact` Callable. */
export const updateContact = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 90},
  async (request) => {
    await requireActiveUser(request.auth);
    return updateContactHandler(request);
  },
);
