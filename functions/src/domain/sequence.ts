/**
 * Monotonic counters.
 *
 * Firestore document ids are 20 random characters, which is both unreadable
 * in a clTRID and longer than the 16-character contact-id limit. A small
 * counter gives short, stable, human-readable numbers instead
 * (spec 5.1, 3.4).
 */
import {FieldValue} from "firebase-admin/firestore";
import {COLLECTIONS, db} from "../config/firebase";

/**
 * Allocates the next value of a named counter.
 *
 * @param {string} name Counter name, e.g. `orders`.
 * @return {Promise<number>} A value never handed out before.
 */
export async function nextSequence(name: string): Promise<number> {
  const ref = db().collection(COLLECTIONS.counters).doc(name);
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const current = (snapshot.data()?.value as number | undefined) ?? 0;
    const next = current + 1;
    tx.set(
      ref,
      {value: next, updatedAt: FieldValue.serverTimestamp()},
      {merge: true},
    );
    return next;
  });
}

/**
 * Zero-pads a sequence number.
 *
 * @param {number} value Sequence value.
 * @param {number} width Total width.
 * @return {string} Padded decimal string.
 */
export function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
