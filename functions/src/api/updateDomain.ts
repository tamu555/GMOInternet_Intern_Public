/**
 * `updateDomain` — `domain:update` (nameservers, contacts, client statuses,
 * registrant, DNSSEC) for a caller-owned domain.
 *
 * Shape: thin Callable -> strict validation -> ownership -> Firestore
 * mutation reservation -> BRIDGE `updateDomain` (sent at most once) ->
 * authoritative `domain:info` re-read -> mirror reconciliation. See
 * `.agents/logs/codex/20260825T083141Z-epp-update-architecture.md` for the
 * full data-flow rationale.
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
  DomainChangeSet,
  DomainInfo,
  DomainUpdateRequest,
  SecDnsUpdateExtension,
} from "../bridge/types";
import {isRegistryError} from "../bridge/errors";
import {adhocClTrid} from "../domain/clTrid";
import {
  normaliseUpdateDomainData,
  type ValidatedDomainChangeSet,
  type ValidatedDomainUpdate,
  type ValidatedSecDnsChange,
} from "../domain/validation";
import {
  assertOwnsContact,
  assertOwnsDomain,
  type OwnedDomain,
} from "../domain/ownership";
import {
  beginMutation,
  markMutationDispatching,
  markMutationRejected,
  markRegistryAccepted,
  prepareMutation,
  reconcileDomainMirror,
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

/** Dependencies `makeUpdateDomainHandler` closes over, all overridable. */
export interface UpdateDomainDependencies {
  firestore?: Firestore;
  getClient?: (registry: RegistryId) => RegistryClient;
}

/** Handler function `onCall` accepts, as produced by the factory below. */
export type UpdateDomainHandler = (
  request: CallableRequest<unknown>,
) => Promise<MutationResult>;

/**
 * `assertOwnsDomain`, tolerating a same-operationId resume of an in-flight
 * mutation. See `updateCallableSupport.ts`'s `assertOwnsOrResumeOwnOperation`
 * for the shared rationale/mechanics.
 *
 * @param {string} uid Caller uid.
 * @param {string} name Canonical domain name.
 * @param {string} operationId Idempotency key on the current request.
 * @param {Firestore} firestore Firestore handle.
 * @return {Promise<OwnedDomain>} The owned domain, resumed or fresh.
 */
function assertOwnsDomainOrResumeOwnOperation(
  uid: string,
  name: string,
  operationId: string,
  firestore: Firestore,
): Promise<OwnedDomain> {
  const ref = firestore
    .collection(COLLECTIONS.domains)
    .doc(`${uid}__${name}`);
  return assertOwnsOrResumeOwnOperation(
    () => assertOwnsDomain(uid, name, firestore),
    ref,
    operationId,
    (data) => {
      if (
        data.uid !== uid ||
        data.name !== name ||
        !isRegistryId(data.registry)
      ) {
        return undefined;
      }
      return {kind: "domain", ref, uid, name, registry: data.registry};
    },
  );
}

/**
 * Builds the wire `add`/`rem` change-set for one side of a `domain:update`.
 *
 * @param {ValidatedDomainChangeSet} set Validated `add` or `remove` block.
 * @return {DomainChangeSet} Wire change-set.
 */
function buildDomainChangeSet(set: ValidatedDomainChangeSet): DomainChangeSet {
  const result: DomainChangeSet = {};
  if (set.nameservers) result.nameservers = set.nameservers;
  if (set.contacts) {
    result.contacts = {};
    for (const contact of set.contacts) {
      result.contacts[contact.role] = contact.contactId;
    }
  }
  if (set.statuses) result.statuses = set.statuses;
  return result;
}

/**
 * Builds the `secDNS` extension payload for a validated `change.secDns`.
 *
 * `replace` is modeled as an atomic remove-all-then-add (RFC 5910
 * `secDNS:update`), not a bare `add`: without the `rem.all`, a stale DS
 * record from before this update would survive alongside the new set.
 *
 * PLACEMENT DECISION (provisional, see plan Step 0 / `bridge/types.ts`):
 * this builder puts `secDNS` on `DomainUpdateRequest.extensions` (the
 * top-level, command-scoped field), not `chg.extensions`. RFC 5910 attaches
 * `secDNS:update` as an `<extension>` sibling of `<update>`, not nested
 * inside `<chg>`; the wire type's `chg.extensions` alternative exists only
 * so this choice can be flipped in one place once Step 0 confirms the real
 * contract against the live Kitaqsign/Kitaqnic Swagger.
 *
 * @param {ValidatedSecDnsChange} change Validated secDNS change.
 * @return {SecDnsUpdateExtension} Wire `secDNS` extension payload.
 */
function buildSecDnsExtension(
  change: ValidatedSecDnsChange,
): SecDnsUpdateExtension {
  if (change.action === "removeAll") {
    return {rem: {all: true}};
  }
  return {rem: {all: true}, add: {dsData: change.dsData}};
}

/**
 * Builds the full `PUT /domains/{name}` body from validated Callable input.
 *
 * Built field-by-field from the validated DTO only: never a spread/merge of
 * client input, so `authInfo` (already structurally unreachable in the DTO)
 * cannot ride along even if a future edit weakened validation.
 *
 * @param {ValidatedDomainUpdate} validated Validated `updateDomain` input.
 * @return {DomainUpdateRequest} Wire request body.
 */
function buildDomainUpdateRequest(
  validated: ValidatedDomainUpdate,
): DomainUpdateRequest {
  const request: DomainUpdateRequest = {};
  if (validated.add) request.add = buildDomainChangeSet(validated.add);
  if (validated.remove) request.rem = buildDomainChangeSet(validated.remove);
  if (validated.change?.registrantContactId) {
    request.chg = {registrant: validated.change.registrantContactId};
  }
  if (validated.change?.secDns) {
    request.extensions = {
      secDNS: buildSecDnsExtension(validated.change.secDns),
    };
  }
  return request;
}

/**
 * Computes the before/expected registry projections for the fields this
 * request touches, from a pre-mutation `domain:info` read.
 *
 * @param {DomainInfo} pre Pre-mutation `domain:info` answer.
 * @param {ValidatedDomainUpdate} validated Validated `updateDomain` input.
 * @return {{before: RegistryProjection, expected: RegistryProjection}}
 *   Touched-field snapshots, comparable against a post-mutation re-read.
 */
function computeProjections(
  pre: DomainInfo,
  validated: ValidatedDomainUpdate,
): {before: RegistryProjection; expected: RegistryProjection} {
  const before: RegistryProjection = {};
  const expected: RegistryProjection = {};

  const touchesNameservers = Boolean(
    validated.add?.nameservers || validated.remove?.nameservers,
  );
  if (touchesNameservers) {
    before.nameservers = pre.nameservers;
    const set = new Set(pre.nameservers);
    for (const ns of validated.add?.nameservers ?? []) set.add(ns);
    for (const ns of validated.remove?.nameservers ?? []) set.delete(ns);
    expected.nameservers = [...set];
  }

  const touchesStatus = Boolean(
    validated.add?.statuses || validated.remove?.statuses,
  );
  if (touchesStatus) {
    before.status = pre.status;
    const set = new Set(pre.status);
    for (const status of validated.add?.statuses ?? []) set.add(status);
    for (const status of validated.remove?.statuses ?? []) set.delete(status);
    // The registry manages `ok` itself and keeps it mutually exclusive with
    // every other status (spec §3.5): adding the first prohibition drops
    // `ok`, removing the last one brings it back. Mirror that here or the
    // post-mutation re-read never matches `expected` and every status
    // update ends `indeterminate`, wedging the domain in
    // `reconciliationRequired`.
    if (set.size > 1) set.delete("ok");
    if (set.size === 0) set.add("ok");
    expected.status = [...set];
  }

  const touchesContacts = Boolean(
    validated.add?.contacts || validated.remove?.contacts,
  );
  if (touchesContacts) {
    before.contacts = pre.contacts;
    const contacts = {...pre.contacts};
    for (const contact of validated.remove?.contacts ?? []) {
      if (contacts[contact.role] === contact.contactId) {
        delete contacts[contact.role];
      }
    }
    for (const contact of validated.add?.contacts ?? []) {
      contacts[contact.role] = contact.contactId;
    }
    expected.contacts = contacts;
  }

  if (validated.change?.registrantContactId) {
    before.registrant = pre.registrant;
    expected.registrant = validated.change.registrantContactId;
  }

  if (validated.change?.secDns) {
    before.secDns = pre.secDns ?? [];
    expected.secDns =
      validated.change.secDns.action === "removeAll" ?
        [] :
        validated.change.secDns.dsData;
  }

  return {before, expected};
}

/**
 * Builds the `updateDomain` Callable handler.
 *
 * @param {UpdateDomainDependencies} dependencies Overridable collaborators.
 * @return {UpdateDomainHandler} Handler suitable for `onCall`.
 */
export function makeUpdateDomainHandler(
  dependencies: UpdateDomainDependencies = {},
): UpdateDomainHandler {
  const firestore = dependencies.firestore ?? db();
  const getClient = dependencies.getClient ?? getRegistryClient;

  return async (request: CallableRequest<unknown>): Promise<MutationResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }
    const uid = request.auth.uid;

    try {
      const validated = normaliseUpdateDomainData(request.data);
      const target = await assertOwnsDomainOrResumeOwnOperation(
        uid,
        validated.domainName,
        validated.operationId,
        firestore,
      );

      for (const contact of validated.add?.contacts ?? []) {
        await assertOwnsContact(
          uid,
          contact.contactId,
          target.registry,
          firestore,
        );
      }
      if (validated.change?.registrantContactId) {
        await assertOwnsContact(
          uid,
          validated.change.registrantContactId,
          target.registry,
          firestore,
        );
      }

      const client = getClient(target.registry);
      const requestHash = computeRequestHash({
        domainName: validated.domainName,
        add: validated.add,
        remove: validated.remove,
        change: validated.change,
      });

      const lease = await beginMutation(
        target,
        validated.operationId,
        "domain:update",
        requestHash,
        firestore,
      );

      if (isTerminalPhase(lease.phase)) {
        return terminalReplayResult(lease, target.name);
      }

      let clTRID = lease.clTRID;

      if (lease.phase === "reserved") {
        const preInfo = await client.infoDomain(
          target.name,
          adhocClTrid("INFO", `${lease.operationId}-pre`),
        );
        const {before, expected} = computeProjections(preInfo, validated);
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
        try {
          await client.updateDomain(
            target.name,
            buildDomainUpdateRequest(validated),
            clTRID as string,
            {uid},
          );
        } catch (error) {
          if (isRegistryError(error) && error.kind === "transport") {
            // Ambiguous: the PUT may or may not have applied. Leave the
            // operation at `dispatching` so a same-operationId replay
            // reconciles via `info` instead of resending the PUT.
            throw new ReconciliationRequiredError();
          }
          if (isRegistryError(error)) {
            await markMutationRejected(lease, firestore);
          }
          throw error;
        }
        await markRegistryAccepted(lease, firestore);
      } else if (lease.phase === "dispatching") {
        // A prior attempt may have already sent the PUT; never resend it.
        await markRegistryAccepted(lease, firestore);
      }

      let decision;
      try {
        decision = await reconcileDomainMirror(lease, client, firestore);
      } catch {
        // The mutation was already accepted by the registry; a failure to
        // re-read it is ambiguous, not a fresh "unavailable" retry signal.
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
      throw toHttpsError(error, "updateDomain");
    }
  };
}

const updateDomainHandler = makeUpdateDomainHandler();

/** Production `updateDomain` Callable. */
export const updateDomain = onCall(
  {secrets: REGISTRY_SECRETS, timeoutSeconds: 90},
  async (request) => {
    await requireActiveUser(request.auth);
    return updateDomainHandler(request);
  },
);
