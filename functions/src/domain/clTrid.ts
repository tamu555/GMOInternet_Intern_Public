/**
 * Deterministic clTRID generation (spec 3.3, FIG.2).
 *
 * The clTRID is derived from the order and the attempt number rather than
 * being random. A retry of the same attempt therefore carries the same id,
 * which is what makes "did my create actually go through?" answerable from
 * the registry's logs. The registry does not enforce uniqueness, so this is
 * purely our discipline.
 *
 * Format: `ORD-000123-CREATE-01`, capped at the recommended 64 characters.
 */
import {pad} from "./sequence";

/** Commands that appear in a clTRID. */
export type ClTridCommand =
  | "CHECK"
  | "CREATE"
  | "INFO"
  /**
   * A `domain:info` sent to a registry the mirror does NOT name, to find out
   * whether a domain the mirror's registry answered 404 for has simply moved
   * (see `confirmGoneAcrossRegistries` in domainLifecycle.ts). Kept apart from
   * `INFO` so a registry-side log line shows at a glance that the call was a
   * verification probe rather than ordinary state reading.
   */
  | "PROBE"
  | "UPDATE"
  | "DELETE"
  | "RESTORE"
  | "POLL"
  | "ACK"
  | "CONTACT"
  | "HOST"
  | "HELLO"
  | "RENEW"
  | "TRANSFER"
  | "ROTATE";

const MAX_LENGTH = 64;

/**
 * Builds the clTRID for one order-scoped command.
 *
 * @param {number} orderSeq Order sequence number.
 * @param {ClTridCommand} command Command being issued.
 * @param {number} attempt 1-based attempt number.
 * @return {string} clTRID for the `X-Cl-TRID` header.
 */
export function orderClTrid(
  orderSeq: number,
  command: ClTridCommand,
  attempt: number,
): string {
  return `ORD-${pad(orderSeq, 6)}-${command}-${pad(attempt, 2)}`.slice(
    0,
    MAX_LENGTH,
  );
}

/**
 * Builds the clTRID for a user-scoped command such as `contact:create`.
 *
 * @param {number} userSeq User sequence number.
 * @param {ClTridCommand} command Command being issued.
 * @param {string} suffix Extra qualifier, e.g. the registry id.
 * @return {string} clTRID for the `X-Cl-TRID` header.
 */
export function userClTrid(
  userSeq: number,
  command: ClTridCommand,
  suffix: string,
): string {
  return `USR-${pad(userSeq, 6)}-${command}-${suffix}`
    .toUpperCase()
    .slice(0, MAX_LENGTH);
}

/**
 * Builds a clTRID for commands that belong to no order, such as the startup
 * `hello` probe or an anonymous availability search.
 *
 * @param {string} scope Short scope label, e.g. `SEARCH`.
 * @param {string} unique Caller-supplied unique part.
 * @return {string} clTRID for the `X-Cl-TRID` header.
 */
export function adhocClTrid(scope: string, unique: string): string {
  return `APP-${scope}-${unique}`.toUpperCase().slice(0, MAX_LENGTH);
}

/**
 * Builds the clTRID for a command that acts on a domain but belongs to no
 * order, such as `domain:delete` and `domain:restore`.
 *
 * The domain name is embedded so a registry-side log line says which domain
 * it was without a lookup, and the caller-supplied `unique` part keeps two
 * deletes of the same name apart.
 *
 * @param {ClTridCommand} command Command being issued.
 * @param {string} domainName Domain the command acts on.
 * @param {string} unique Caller-supplied unique part.
 * @return {string} clTRID for the `X-Cl-TRID` header.
 */
export function domainClTrid(
  command: ClTridCommand,
  domainName: string,
  unique: string,
): string {
  const label = domainName.replace(/[^A-Za-z0-9]+/g, "-");
  return `DOM-${command}-${label}-${unique}`.toUpperCase().slice(0, 64);
}
