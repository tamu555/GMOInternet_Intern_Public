/**
 * authInfo (transfer passphrase) generation.
 *
 * RFC 9154 recommends at least 128 bits of entropy; 16 random bytes gives
 * exactly that, and base64url keeps it inside the registry's 64-character
 * limit while staying copy-pasteable (spec 3.4).
 */
import {randomBytes} from "node:crypto";

/**
 * Generates a fresh authInfo passphrase.
 *
 * @return {string} 22-character base64url string.
 */
export function generateAuthInfo(): string {
  return randomBytes(16).toString("base64url");
}
