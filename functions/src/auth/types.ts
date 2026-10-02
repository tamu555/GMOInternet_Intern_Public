import type {Timestamp} from "firebase-admin/firestore";

import type {AUTH_PROVIDER, USER_STATUS} from "./constants.js";

export type AuthProvider =
  typeof AUTH_PROVIDER[keyof typeof AUTH_PROVIDER];

export type UserStatus = typeof USER_STATUS[keyof typeof USER_STATUS];

export type CountryCode = "JP" | "US" | "GB" | "CN" | "KR" | "TW";
export type Gender = "male" | "female" | "other" | "no_answer";
export type AccountType = "individual" | "sole-proprietor" | "corporate";

export interface JapanAddress {
  country: "JP";
  postalCode: string;
  prefecture: string;
  city: string;
  addressLine: string;
  building: string | null;
}

export interface InternationalAddress {
  country: Exclude<CountryCode, "JP">;
  postalCode: string;
  state: string | null;
  city: string;
  addressLine1: string;
  addressLine2: string | null;
}

export type Address = JapanAddress | InternationalAddress;

export interface BusinessInfo {
  /** 会社名 for corporate, 屋号 (relabeled in the UI only) for sole-proprietor. */
  companyName: string;
  department: string | null;
  contactPerson: string;
}

export interface UserProfile {
  name: string;
  nameKana: string;
  phoneNumber: string;
  dateOfBirth: string;
  gender: Gender;
  newsletterOptIn: boolean;
  accountType: AccountType;
  /** Required (non-null) iff accountType !== "individual". */
  business: BusinessInfo | null;
  address: Address;
}

interface UserDocumentCommon {
  uid: string;
  email: string;
  authProvider: AuthProvider;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletionRequestedAt: Timestamp | null;
  scheduledPurgeAt: Timestamp | null;
  purgeTaskName: string | null;
}

export interface PendingAdditionalInfoUser extends UserDocumentCommon {
  status: "pending_additional_info";
  profile: null;
}

export interface ActiveUser extends UserDocumentCommon {
  status: "active";
  profile: UserProfile;
}

export interface PendingDeletionUser extends UserDocumentCommon {
  status: "pending_deletion";
  profile: UserProfile;
}

export interface PurgingUser extends UserDocumentCommon {
  status: "purging";
  profile: UserProfile;
}

export type UserDocument =
  | PendingAdditionalInfoUser
  | ActiveUser
  | PendingDeletionUser
  | PurgingUser;

export interface TimestampLike {
  toMillis(): number;
}

/**
 * `verificationCodes/{email}` - the signup wizard's step-2 e-mail check.
 *
 * Deliberately readable by unauthenticated clients (firestore.rules): no
 * mail delivery exists in this project, so the address being verified reads
 * its own code straight out of Firestore. Writes are Admin-SDK only, so a
 * client can never mint a code, extend one, or flip `verified` itself.
 *
 * The document id is the normalised (trimmed, lower-cased) address, which is
 * what lets the client look its own code up by the address it just typed.
 */
export interface VerificationCodeDocument {
  email: string;
  code: string;
  /** Until when the code may be submitted. */
  expiresAt: Timestamp;
  attemptsRemaining: number;
  /** Until when a resend request is rejected as too soon. */
  resendAvailableAt: Timestamp;
  verified: boolean;
  /** Until when a successful verification may be spent on registration. */
  verifiedUntil: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * The subset of a verification document the pure predicates need, expressed
 * without `Timestamp` so they stay testable with plain fakes.
 */
export interface VerificationCodeState {
  code: string;
  expiresAt: TimestampLike;
  attemptsRemaining: number;
  resendAvailableAt: TimestampLike;
  verified: boolean;
  verifiedUntil: TimestampLike | null;
}
