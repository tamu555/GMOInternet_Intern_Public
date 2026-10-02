/**
 * The only e-mail domains an account may use (spec 3.4: the local part is
 * free, the domain is not). Mirrors `domain/validation.ts`'s list of the same
 * registry constraint - `logic.test.ts` asserts the two never drift apart.
 */
export const ALLOWED_EMAIL_DOMAINS = [
  "example.com",
  "example.net",
  "example.org",
] as const;

export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MILLISECONDS_PER_SECOND = 1_000;
export const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;

export const SESSION_COOKIE_EXPIRES_IN_MS = 5 * MILLISECONDS_PER_DAY;

// Provisional five-minute freshness window from auth.md sections 4.8 and 8.
export const AUTH_TIME_FRESHNESS_SECONDS = 5 * SECONDS_PER_MINUTE;

// Tolerance for clock skew between the token issuer and this server, so a
// legitimately fresh auth_time that appears slightly ahead of our clock is
// not misread as a suspicious future timestamp.
export const CLOCK_SKEW_TOLERANCE_SECONDS = SECONDS_PER_MINUTE;

export const PURGE_DELAY_SECONDS =
  30 * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;

// Provisional cleanup window from auth.md sections 4.3 and 8.
export const ABANDONED_SIGNUP_CLEANUP_DAYS = 7;

// Provisional retry interval for stuck purges from auth.md sections 4.9 and 8.
export const PURGING_RETRY_DELAY_SECONDS =
  MINUTES_PER_HOUR * SECONDS_PER_MINUTE;

export const SESSION_COOKIE_NAME = "session";

// --- Signup wizard step 2: e-mail verification codes ---

/** Digits in a verification code (frontend verifySchema.ts mirrors this). */
export const VERIFICATION_CODE_LENGTH = 6;

/** Exclusive upper bound of the code space, i.e. 10 ** the length above. */
export const VERIFICATION_CODE_SPACE = 10 ** VERIFICATION_CODE_LENGTH;

/** How long a freshly issued code may be submitted. */
export const VERIFICATION_CODE_TTL_MS =
  10 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

/** Wrong submissions accepted before the code is burned. */
export const VERIFICATION_MAX_ATTEMPTS = 5;

/** Shortest interval between two resend requests for one address. */
export const VERIFICATION_RESEND_INTERVAL_MS = 60 * MILLISECONDS_PER_SECOND;

/**
 * How long a successful verification may be spent on a registration call.
 * The wizard still has 契約者情報 and 内容確認 to go after step 2, so this
 * window is deliberately longer than the code's own TTL: the code stops
 * being submittable after ten minutes, but the visitor keeps thirty to
 * finish the form.
 */
export const VERIFICATION_GRANT_TTL_MS =
  30 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export const AUTH_PROVIDER = {
  PASSWORD: "password",
  GOOGLE: "google.com",
} as const;

export const USER_STATUS = {
  PENDING_ADDITIONAL_INFO: "pending_additional_info",
  ACTIVE: "active",
  PENDING_DELETION: "pending_deletion",
  PURGING: "purging",
} as const;
