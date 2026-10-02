/**
 * Pure helpers for the signup wizard's e-mail verification codes.
 *
 * Everything here is side-effect free so the rules that decide whether a
 * code may be submitted, resent, or spent on a registration can be unit
 * tested without a Firestore connection. The Firestore and Callable layer
 * lives in `verification.ts`.
 */
import {randomInt} from "node:crypto";

import {
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_SPACE,
} from "./constants.js";
import type {VerificationCodeState} from "./types.js";

/** Firestore's hard limit on a document id. */
const MAX_DOCUMENT_ID_BYTES = 1_500;

/** Firestore reserves ids of the form `__name__`. */
const RESERVED_DOCUMENT_ID_PATTERN = /^__.*__$/;

const CODE_PATTERN = new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`);

/**
 * Normalises an address into the `verificationCodes` document id.
 *
 * The client looks its own code up by the address it typed, so both sides
 * must agree on one spelling; lower-casing is that agreement (Firebase Auth
 * lower-cases stored addresses too).
 *
 * @param {string} email Address as submitted.
 * @return {string} Normalised address.
 */
export function normaliseVerificationEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Checks whether a normalised address is usable as a Firestore document id.
 *
 * `isValidEmailAddress` already rejects whitespace and multiple `@`, but not
 * a slash, which would silently turn one id into a subcollection path.
 *
 * @param {string} email Normalised address.
 * @return {boolean} Whether the address may be used as a document id.
 */
export function isSafeVerificationDocumentId(email: string): boolean {
  if (email.length === 0 || email.includes("/")) {
    return false;
  }
  if (email === "." || email === "..") {
    return false;
  }
  if (RESERVED_DOCUMENT_ID_PATTERN.test(email)) {
    return false;
  }

  return Buffer.byteLength(email, "utf8") <= MAX_DOCUMENT_ID_BYTES;
}

/**
 * Checks the shape of a client-submitted code before it is compared.
 *
 * @param {unknown} code Client-submitted code.
 * @return {boolean} Whether the value is exactly the expected digit string.
 */
export function isWellFormedVerificationCode(code: unknown): code is string {
  return typeof code === "string" && CODE_PATTERN.test(code);
}

/**
 * Draws a fresh zero-padded code from a cryptographic source.
 *
 * `Math.random` is not acceptable even though the code ends up readable by
 * the client: a predictable sequence would let one visitor guess the code
 * issued to a different address without reading anything at all.
 *
 * @return {string} A zero-padded code of VERIFICATION_CODE_LENGTH digits.
 */
export function generateVerificationCode(): string {
  return String(randomInt(0, VERIFICATION_CODE_SPACE))
    .padStart(VERIFICATION_CODE_LENGTH, "0");
}

/**
 * Compares two codes without leaking the matching prefix length by timing.
 *
 * @param {string} expected Stored code.
 * @param {string} provided Client-submitted code.
 * @return {boolean} Whether the two codes are identical.
 */
export function codesMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }

  return difference === 0;
}

/**
 * Checks whether a stored code may still be submitted.
 *
 * @param {VerificationCodeState} state Stored verification state.
 * @param {number} nowMs Current time in epoch milliseconds.
 * @return {boolean} Whether the code is unverified, unexpired and unburned.
 */
export function isCodeSubmittable(
  state: VerificationCodeState,
  nowMs: number,
): boolean {
  return !state.verified &&
    state.attemptsRemaining > 0 &&
    state.expiresAt.toMillis() > nowMs;
}

/**
 * Checks whether a resend request has waited out the cooldown.
 *
 * @param {VerificationCodeState} state Stored verification state.
 * @param {number} nowMs Current time in epoch milliseconds.
 * @return {boolean} Whether a new code may be issued now.
 */
export function isResendAllowed(
  state: VerificationCodeState,
  nowMs: number,
): boolean {
  return state.resendAvailableAt.toMillis() <= nowMs;
}

/**
 * Checks whether a past verification may still be spent on a registration.
 *
 * @param {VerificationCodeState} state Stored verification state.
 * @param {number} nowMs Current time in epoch milliseconds.
 * @return {boolean} Whether the verification grant is still valid.
 */
export function isVerificationGrantValid(
  state: VerificationCodeState,
  nowMs: number,
): boolean {
  return state.verified &&
    state.verifiedUntil !== null &&
    state.verifiedUntil.toMillis() > nowMs;
}
