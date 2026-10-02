import type {
  CollectionReference,
  DocumentReference,
} from "firebase-admin/firestore";

import {COLLECTIONS, db} from "../config/firebase.js";
import {normaliseVerificationEmail} from "./verificationCodes.js";
import type {UserDocument, VerificationCodeDocument} from "./types.js";

export const usersCollection = db().collection(
  COLLECTIONS.users,
) as CollectionReference<UserDocument>;

export const verificationCodesCollection = db().collection(
  COLLECTIONS.verificationCodes,
) as CollectionReference<VerificationCodeDocument>;

/**
 * Gets the typed users/{uid} document reference.
 *
 * @param {string} uid Firebase Authentication user ID.
 * @return {DocumentReference<UserDocument>} Typed user reference.
 */
export function userDocument(uid: string): DocumentReference<UserDocument> {
  return usersCollection.doc(uid);
}

/**
 * Gets the typed verificationCodes/{email} document reference.
 *
 * The address is normalised here rather than at the call sites so a stray
 * "Member@Example.com" can never write a second document the client - which
 * looks the code up by the normalised address - would fail to find.
 *
 * @param {string} email E-mail address being verified.
 * @return {DocumentReference<VerificationCodeDocument>} Typed reference.
 */
export function verificationDocument(
  email: string,
): DocumentReference<VerificationCodeDocument> {
  return verificationCodesCollection.doc(normaliseVerificationEmail(email));
}
