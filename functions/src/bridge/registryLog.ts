/**
 * RegistryLog writer.
 *
 * Every registry command lands here with its clTRID, svTRID, HTTP status,
 * result code and duration. This is the investigation key when something goes
 * wrong on the registry side (spec 7.2), so a logging failure must never take
 * down the command it was describing.
 */
import {FieldValue} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {COLLECTIONS, db} from "../config/firebase";
import type {RegistryId} from "../config/options";

/** One row of the RegistryLog collection. */
export interface RegistryLogEntry {
  registry: RegistryId;
  command: string;
  method: string;
  path: string;
  clTRID: string;
  svTRID?: string | null;
  httpStatus?: number | null;
  resultCode?: number | null;
  durationMs: number;
  ok: boolean;
  errorKind?: string | null;
  errorMessage?: string | null;
  uid?: string | null;
  orderId?: string | null;
}

/**
 * Appends one entry to the RegistryLog collection.
 *
 * Fire-and-forget on purpose: the caller awaits it, but a rejection is
 * swallowed and mirrored to Cloud Logging instead of failing the command.
 *
 * @param {RegistryLogEntry} entry Row to persist.
 * @return {Promise<void>} Resolves once the write settled.
 */
export async function writeRegistryLog(
  entry: RegistryLogEntry,
): Promise<void> {
  try {
    await db()
      .collection(COLLECTIONS.registryLogs)
      .add({...entry, requestedAt: FieldValue.serverTimestamp()});
  } catch (error) {
    logger.error("failed to write RegistryLog", {entry, error});
  }
}
