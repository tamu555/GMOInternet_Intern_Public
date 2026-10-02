import {randomBytes, timingSafeEqual} from "node:crypto";

import {Timestamp} from "firebase-admin/firestore";
import type {DecodedIdToken} from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";
import {onRequest} from "firebase-functions/v2/https";
import type {Request} from "firebase-functions/v2/https";
import type {Response} from "express";

import {adminAuth as auth, db} from "../config/firebase.js";
import {
  AUTH_PROVIDER,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_SECOND,
  SESSION_COOKIE_EXPIRES_IN_MS,
  SESSION_COOKIE_NAME,
  USER_STATUS,
} from "./constants.js";
import {userDocument} from "./firestore.js";
import type {AuthProvider, UserDocument} from "./types.js";

const COOKIE_PATH = "/";
const CSRF_TOKEN_BYTE_LENGTH = 32;

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_SERVER_ERROR: 500,
} as const;

const CLIENT_ERROR_CODE = {
  INVALID_ARGUMENT: "invalid-argument",
  UNAUTHENTICATED: "unauthenticated",
  PERMISSION_DENIED: "permission-denied",
  METHOD_NOT_ALLOWED: "method-not-allowed",
  INTERNAL: "internal",
} as const;

interface SessionLoginBody {
  idToken: string;
  csrfToken: string;
}

type LoginResolution =
  | {kind: "additional_info_required"}
  | {kind: "active"}
  | {
    kind: "pending_deletion";
    scheduledPurgeAt: Timestamp | null;
  }
  | {kind: "permission_denied"};

/**
 * Sends the stable client-facing error envelope.
 *
 * @param {Response} response HTTP response.
 * @param {number} statusCode HTTP status code.
 * @param {string} code Stable client error code.
 * @param {string} message Generic client-facing message.
 */
function sendClientError(
  response: Response,
  statusCode: number,
  code: string,
  message: string,
): void {
  response.status(statusCode).json({error: {code, message}});
}

/**
 * Prevents authentication responses from being cached.
 *
 * @param {Response} response HTTP response.
 */
function setNoStore(response: Response): void {
  response.set("Cache-Control", "no-store");
}

/**
 * Writes the secure Firebase session cookie.
 *
 * @param {Response} response HTTP response.
 * @param {string} sessionCookie Verified Firebase session cookie.
 */
function setSessionCookie(response: Response, sessionCookie: string): void {
  const maxAgeSeconds = Math.floor(
    SESSION_COOKIE_EXPIRES_IN_MS / MILLISECONDS_PER_SECOND,
  );
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionCookie)}; ` +
      `Max-Age=${maxAgeSeconds}; Path=${COOKIE_PATH}; HttpOnly; Secure; ` +
      "SameSite=Strict",
  );
}

/**
 * Clears the session cookie using the same security attributes.
 *
 * @param {Response} response HTTP response.
 */
function clearSessionCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=${COOKIE_PATH}; ` +
      "HttpOnly; Secure; SameSite=Strict",
  );
}

/**
 * Reads one unambiguous cookie value without an extra parser dependency.
 *
 * @param {Request} request HTTP request.
 * @param {string} name Cookie name.
 * @return {string|undefined} Decoded cookie value when exactly one is present.
 */
function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== "string") {
    return undefined;
  }

  let cookieValue: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0 || part.slice(0, separatorIndex).trim() !== name) {
      continue;
    }

    if (cookieValue !== undefined) {
      return undefined;
    }

    try {
      cookieValue = decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return undefined;
    }
  }

  return cookieValue;
}

/**
 * Validates and narrows the untrusted login request body.
 *
 * @param {unknown} body Untrusted request body.
 * @return {SessionLoginBody|undefined} Validated body when well formed.
 */
function parseSessionLoginBody(body: unknown): SessionLoginBody | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.idToken !== "string" ||
    candidate.idToken.length === 0 ||
    typeof candidate.csrfToken !== "string" ||
    candidate.csrfToken.length === 0
  ) {
    return undefined;
  }

  return {
    idToken: candidate.idToken,
    csrfToken: candidate.csrfToken,
  };
}

/**
 * Validates and narrows a logout request body carrying only a CSRF token.
 *
 * @param {unknown} body Untrusted request body.
 * @return {string|undefined} The validated CSRF token when well formed.
 */
function parseCsrfOnlyBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.csrfToken !== "string" ||
    candidate.csrfToken.length === 0
  ) {
    return undefined;
  }

  return candidate.csrfToken;
}

/**
 * Compares the two CSRF token submissions without timing leakage.
 *
 * @param {string|undefined} headerToken Token from X-CSRF-Token.
 * @param {string} bodyToken Token from the request body.
 * @return {boolean} Whether both non-empty submissions match.
 */
function csrfTokensMatch(
  headerToken: string | undefined,
  bodyToken: string,
): boolean {
  if (!headerToken) {
    return false;
  }

  const headerTokenBytes = Buffer.from(headerToken);
  const bodyTokenBytes = Buffer.from(bodyToken);
  if (headerTokenBytes.length !== bodyTokenBytes.length) {
    return false;
  }

  return timingSafeEqual(headerTokenBytes, bodyTokenBytes);
}

/**
 * Extracts the provider used for this Firebase sign-in.
 *
 * @param {DecodedIdToken} token Verified Firebase ID token.
 * @return {string|undefined} Provider claim when present.
 */
function getSignInProvider(token: DecodedIdToken): string | undefined {
  const provider = token.firebase?.sign_in_provider;
  return typeof provider === "string" ? provider : undefined;
}

/**
 * Narrows a provider claim to the providers stored by this application.
 *
 * @param {string} provider Provider claim.
 * @return {boolean} Whether this is a supported provider.
 */
function isSupportedProvider(provider: string): provider is AuthProvider {
  return (
    provider === AUTH_PROVIDER.PASSWORD || provider === AUTH_PROVIDER.GOOGLE
  );
}

/**
 * Resolves and serializes the Firestore-backed login state transition.
 *
 * @param {DecodedIdToken} token Verified Firebase ID token.
 * @param {string|undefined} provider Sign-in provider claim.
 * @return {Promise<LoginResolution>} Firestore-backed login resolution.
 */
async function resolveLoginState(
  token: DecodedIdToken,
  provider: string | undefined,
): Promise<LoginResolution> {
  const reference = userDocument(token.uid);

  return db().runTransaction(async (transaction): Promise<LoginResolution> => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      if (
        provider !== AUTH_PROVIDER.GOOGLE ||
        typeof token.email !== "string" ||
        token.email.length === 0
      ) {
        return {kind: "permission_denied"};
      }

      const now = Timestamp.now();
      const pendingUser: UserDocument = {
        uid: token.uid,
        email: token.email,
        authProvider: AUTH_PROVIDER.GOOGLE,
        status: USER_STATUS.PENDING_ADDITIONAL_INFO,
        profile: null,
        createdAt: now,
        updatedAt: now,
        deletionRequestedAt: null,
        scheduledPurgeAt: null,
        purgeTaskName: null,
      };
      transaction.create(reference, pendingUser);
      return {kind: "additional_info_required"};
    }

    const user = snapshot.data();
    if (!user || !provider || !isSupportedProvider(provider)) {
      return {kind: "permission_denied"};
    }
    if (user.authProvider !== provider) {
      return {kind: "permission_denied"};
    }

    if (user.status === USER_STATUS.PENDING_ADDITIONAL_INFO) {
      return {kind: "additional_info_required"};
    }
    if (user.status === USER_STATUS.PENDING_DELETION) {
      return {
        kind: "pending_deletion",
        scheduledPurgeAt: user.scheduledPurgeAt,
      };
    }
    if (user.status === USER_STATUS.ACTIVE) {
      return {kind: "active"};
    }
    if (user.status === USER_STATUS.PURGING) {
      return {kind: "permission_denied"};
    }

    return {kind: "permission_denied"};
  });
}

/**
 * Extracts only a non-sensitive error code for server-side logging.
 *
 * @param {unknown} error Thrown value.
 * @return {string} SDK error code or unknown.
 */
function getSafeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }

  const errorCode = (error as {code?: unknown}).code;
  return typeof errorCode === "string" ? errorCode : "unknown";
}

export const sessionLogin = onRequest(
  {cors: false},
  async (request, response) => {
    setNoStore(response);
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      sendClientError(
        response,
        HTTP_STATUS.METHOD_NOT_ALLOWED,
        CLIENT_ERROR_CODE.METHOD_NOT_ALLOWED,
        "Only POST requests are accepted.",
      );
      return;
    }

    const body = parseSessionLoginBody(request.body as unknown);
    if (!body) {
      sendClientError(
        response,
        HTTP_STATUS.BAD_REQUEST,
        CLIENT_ERROR_CODE.INVALID_ARGUMENT,
        "Invalid request.",
      );
      return;
    }

    // Provisional double-submit choice pending the frontend token issuer
    // design.
    if (!csrfTokensMatch(request.get("X-CSRF-Token"), body.csrfToken)) {
      sendClientError(
        response,
        HTTP_STATUS.PERMISSION_DENIED,
        CLIENT_ERROR_CODE.PERMISSION_DENIED,
        "Request rejected.",
      );
      return;
    }

    let decodedToken: DecodedIdToken;
    try {
      decodedToken = await auth().verifyIdToken(body.idToken);
    } catch {
      clearSessionCookie(response);
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    let resolution: LoginResolution;
    try {
      resolution = await resolveLoginState(
        decodedToken,
        getSignInProvider(decodedToken),
      );
    } catch (error: unknown) {
      logger.error("Failed to resolve session login state.", {
        errorCode: getSafeErrorCode(error),
      });
      sendClientError(
        response,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        CLIENT_ERROR_CODE.INTERNAL,
        "Unable to complete the request.",
      );
      return;
    }

    if (resolution.kind === "additional_info_required") {
      clearSessionCookie(response);
      response.status(HTTP_STATUS.OK).json({
        status: "additional_info_required",
      });
      return;
    }

    if (resolution.kind === "pending_deletion") {
      clearSessionCookie(response);
      const purgeAt = resolution.scheduledPurgeAt;
      const scheduledPurgeAtMs = purgeAt ? purgeAt.toMillis() : Date.now();
      const scheduledPurgeAt = purgeAt ? purgeAt.toDate().toISOString() : null;
      const daysRemaining = Math.max(
        0,
        Math.ceil((scheduledPurgeAtMs - Date.now()) / MILLISECONDS_PER_DAY),
      );
      response.status(HTTP_STATUS.OK).json({
        status: "pending_deletion",
        scheduledPurgeAt,
        daysRemaining,
      });
      return;
    }

    if (resolution.kind === "permission_denied") {
      clearSessionCookie(response);
      sendClientError(
        response,
        HTTP_STATUS.PERMISSION_DENIED,
        CLIENT_ERROR_CODE.PERMISSION_DENIED,
        "Unable to sign in.",
      );
      return;
    }

    try {
      const sessionCookie = await auth().createSessionCookie(body.idToken, {
        expiresIn: SESSION_COOKIE_EXPIRES_IN_MS,
      });
      setSessionCookie(response, sessionCookie);
      response.status(HTTP_STATUS.OK).json({status: "ok"});
    } catch (error: unknown) {
      logger.error("Failed to create a session cookie.", {
        errorCode: getSafeErrorCode(error),
      });
      clearSessionCookie(response);
      sendClientError(
        response,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        CLIENT_ERROR_CODE.INTERNAL,
        "Unable to complete the request.",
      );
    }
  },
);

export const sessionLogout = onRequest(
  {cors: false},
  async (request, response) => {
    setNoStore(response);
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      sendClientError(
        response,
        HTTP_STATUS.METHOD_NOT_ALLOWED,
        CLIENT_ERROR_CODE.METHOD_NOT_ALLOWED,
        "Only POST requests are accepted.",
      );
      return;
    }

    const csrfToken = parseCsrfOnlyBody(request.body as unknown);
    if (
      !csrfToken ||
      !csrfTokensMatch(request.get("X-CSRF-Token"), csrfToken)
    ) {
      sendClientError(
        response,
        HTTP_STATUS.PERMISSION_DENIED,
        CLIENT_ERROR_CODE.PERMISSION_DENIED,
        "Request rejected.",
      );
      return;
    }

    clearSessionCookie(response);
    const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionCookie) {
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    let decodedToken: DecodedIdToken;
    try {
      decodedToken = await auth().verifySessionCookie(sessionCookie, true);
    } catch {
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    try {
      await auth().revokeRefreshTokens(decodedToken.uid);
      response.status(HTTP_STATUS.OK).json({status: "ok"});
    } catch (error: unknown) {
      logger.error("Failed to revoke refresh tokens during logout.", {
        errorCode: getSafeErrorCode(error),
      });
      sendClientError(
        response,
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        CLIENT_ERROR_CODE.INTERNAL,
        "Unable to complete the request.",
      );
    }
  },
);

export const issueCsrfToken = onRequest(
  {cors: false},
  async (request, response) => {
    setNoStore(response);
    if (request.method !== "GET") {
      response.set("Allow", "GET");
      sendClientError(
        response,
        HTTP_STATUS.METHOD_NOT_ALLOWED,
        CLIENT_ERROR_CODE.METHOD_NOT_ALLOWED,
        "Only GET requests are accepted.",
      );
      return;
    }

    const csrfToken = randomBytes(CSRF_TOKEN_BYTE_LENGTH).toString(
      "base64url",
    );
    response.status(HTTP_STATUS.OK).json({csrfToken});
  },
);

export const sessionMe = onRequest(
  {cors: false},
  async (request, response) => {
    setNoStore(response);
    if (request.method !== "GET") {
      response.set("Allow", "GET");
      sendClientError(
        response,
        HTTP_STATUS.METHOD_NOT_ALLOWED,
        CLIENT_ERROR_CODE.METHOD_NOT_ALLOWED,
        "Only GET requests are accepted.",
      );
      return;
    }

    const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionCookie) {
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    let decodedToken: DecodedIdToken;
    try {
      decodedToken = await auth().verifySessionCookie(sessionCookie, true);
    } catch {
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    const snapshot = await userDocument(decodedToken.uid).get();
    const user = snapshot.data();
    if (!user || user.status !== USER_STATUS.ACTIVE) {
      sendClientError(
        response,
        HTTP_STATUS.UNAUTHENTICATED,
        CLIENT_ERROR_CODE.UNAUTHENTICATED,
        "Authentication failed.",
      );
      return;
    }

    response.status(HTTP_STATUS.OK).json({
      id: user.uid,
      email: user.email,
      displayName: user.profile.name,
    });
  },
);
