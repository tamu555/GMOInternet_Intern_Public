/**
 * Registry contact management (spec 5.1, 6.8).
 *
 * One contact per member per registry, reused by every domain that member
 * owns. Creating a contact per order would burn through the 16-character id
 * space and produce a stream of 2302s.
 *
 * Contact ids are allocated from a counter (`U000123`) rather than derived
 * from the Firebase uid: a uid is 28 characters and the registry limit is 16.
 * The id is stored on the user document, so it stays stable for that member
 * forever afterwards.
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";
import {getRegistryClient} from "../bridge/registryRouter";
import {isRegistryError} from "../bridge/errors";
import type {ContactCreateRequest} from "../bridge/types";
import {generateAuthInfo} from "./authInfo";
import {userClTrid} from "./clTrid";
import {nextSequence, pad} from "./sequence";
import {
  buildContactEmail,
  normaliseContactName,
} from "./validation";

/** Contact attributes a member can influence from the order form. */
export interface ContactProfileInput {
  name?: string;
  emailLocalPart?: string;
}

/** The member-level contact identity, shared by both registries. */
export interface UserContactProfile {
  userSeq: number;
  contactId: string;
  contactName: string;
  contactEmail: string;
  contactAuthInfo: string;
}

/**
 * Loads the member's contact identity, allocating it on first use.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {ContactProfileInput} input Optional overrides from the order form.
 * @return {Promise<UserContactProfile>} Stable contact identity.
 */
export async function ensureUserContactProfile(
  uid: string,
  input: ContactProfileInput = {},
): Promise<UserContactProfile> {
  const ref = db().collection(COLLECTIONS.users).doc(uid);
  const snapshot = await ref.get();
  const existing = snapshot.data();

  if (existing?.contactId && existing?.userSeq) {
    return {
      userSeq: existing.userSeq as number,
      contactId: existing.contactId as string,
      contactName: existing.contactName as string,
      contactEmail: existing.contactEmail as string,
      contactAuthInfo: existing.contactAuthInfo as string,
    };
  }

  const userSeq = await nextSequence("users");
  const contactId = `U${pad(userSeq, 6)}`;
  const profile: UserContactProfile = {
    userSeq,
    contactId,
    contactName: normaliseContactName(input.name),
    contactEmail: buildContactEmail(
      input.emailLocalPart,
      contactId.toLowerCase(),
    ),
    contactAuthInfo: generateAuthInfo(),
  };

  await ref.set(
    {...profile, uid, updatedAt: FieldValue.serverTimestamp()},
    {merge: true},
  );
  return profile;
}

/**
 * Builds the `contact:create` body for a member.
 *
 * Every field other than the id and the e-mail local part is fixed by the
 * registry's allow-lists, so there is nothing here for the UI to collect.
 *
 * @param {UserContactProfile} profile Member contact identity.
 * @return {ContactCreateRequest} Request body.
 */
function buildContactRequest(
  profile: UserContactProfile,
): ContactCreateRequest {
  return {
    id: profile.contactId,
    postalInfo: {
      name: profile.contactName,
      org: "",
      addr: {
        street: "N/A",
        city: "N/A",
        sp: "",
        pc: "",
        cc: "JP",
      },
    },
    voice: "",
    fax: "",
    email: profile.contactEmail,
    authInfo: profile.contactAuthInfo,
  };
}

/** Result of making sure a contact exists on one registry. */
export interface EnsuredContact {
  contactId: string;
  registry: RegistryId;
  /** True when this call created it rather than finding it already there. */
  created: boolean;
}

/**
 * Makes sure the member has a contact on one registry, creating it if needed.
 *
 * A 2302 from `contact:create` is treated as success: contact ids are
 * deterministic, so "already exists" means an earlier attempt of ours got
 * through — the same recovery reasoning as spec 6.7.
 *
 * @param {string} uid Firebase Authentication uid.
 * @param {RegistryId} registry Registry the contact is needed on.
 * @param {ContactProfileInput} input Optional overrides from the order form.
 * @param {string} orderId Correlation id for the RegistryLog row.
 * @return {Promise<EnsuredContact>} The contact id to use as registrant.
 */
export async function ensureRegistryContact(
  uid: string,
  registry: RegistryId,
  input: ContactProfileInput,
  orderId?: string,
): Promise<EnsuredContact> {
  const profile = await ensureUserContactProfile(uid, input);
  const linkId = `${uid}__${registry}`;
  const linkRef = db().collection(COLLECTIONS.registryContacts).doc(linkId);
  const link = await linkRef.get();

  if (link.data()?.state === "ready") {
    return {contactId: profile.contactId, registry, created: false};
  }

  const clTRID = userClTrid(profile.userSeq, "CONTACT", registry);

  try {
    const outcome = await getRegistryClient(registry).createContact(
      buildContactRequest(profile),
      clTRID,
      {uid, orderId},
    );
    await linkRef.set(
      {
        uid,
        registry,
        contactId: profile.contactId,
        state: "ready",
        alreadyExisted: outcome.alreadyExisted,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return {
      contactId: profile.contactId,
      registry,
      created: !outcome.alreadyExisted,
    };
  } catch (error) {
    const payload = isRegistryError(error) ?
      error.toLogPayload() :
      {message: String(error)};
    logger.error("contact:create failed", {uid, registry, ...payload});
    await linkRef.set(
      {
        uid,
        registry,
        contactId: profile.contactId,
        state: "failed",
        lastError: payload,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    throw error;
  }
}
