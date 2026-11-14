/**
 * Shared-password access for the web chat.
 *
 * The web app (apps/web) checks the password and stores a signed token in an
 * httpOnly cookie; the eve channel verifies that cookie on every request. Both
 * services read the same `EVE_ACCESS_PASSWORD`, and the signing key is derived
 * from it, so there is no database and changing the password signs everyone out.
 *
 * @packageDocumentation
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { UnauthenticatedError, verifyJwtHmac } from "eve/channels/auth";
import type { AuthFn, VerifyJwtHmacConfig } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";

/** Name of the httpOnly cookie that holds the access token. */
export const ACCESS_COOKIE = "eve_access";

/** How long an access token (and its cookie) stays valid: 30 days. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const ISSUER = "eve-web-chat";
const AUDIENCE = "eve";

/**
 * Reads the configured access password.
 *
 * @returns `EVE_ACCESS_PASSWORD`, or `undefined` when it is unset or empty.
 */
function accessPassword(): string | undefined {
  const password = process.env.EVE_ACCESS_PASSWORD;
  return password === undefined || password === "" ? undefined : password;
}

/**
 * Derives the token signing key from the password, so no separate secret is needed.
 *
 * @param password - The configured access password.
 * @returns A base64url HMAC-SHA256 key.
 */
function signingKey(password: string): string {
  return createHmac("sha256", password)
    .update("eve-access-token:v1")
    .digest("base64url");
}

/**
 * Builds the verifier config matching the tokens {@link signAccessToken} mints.
 *
 * @param password - The configured access password.
 * @returns Config for `verifyJwtHmac`.
 */
function tokenConfig(password: string): VerifyJwtHmacConfig {
  return {
    algorithm: "HS256",
    audiences: [AUDIENCE],
    issuer: ISSUER,
    secret: signingKey(password),
  };
}

/**
 * Reports whether this deployment has an access password.
 *
 * @returns `true` when `EVE_ACCESS_PASSWORD` is set.
 */
export function isAccessConfigured(): boolean {
  return accessPassword() !== undefined;
}

/**
 * Compares a submitted password with the configured one in constant time.
 *
 * @param candidate - The password a visitor entered.
 * @returns `true` on a match; always `false` when no password is configured.
 */
export function checkAccessPassword(candidate: string): boolean {
  const password = accessPassword();
  if (password === undefined) {
    return false;
  }
  return timingSafeEqual(compareDigest(candidate), compareDigest(password));
}

/**
 * Hashes a password to a fixed length so `timingSafeEqual` can compare values of any length.
 *
 * @param value - The password to hash.
 * @returns The HMAC-SHA256 digest.
 */
function compareDigest(value: string): Buffer {
  return createHmac("sha256", "eve-access-compare").update(value).digest();
}

/** Claims carried by an access token. */
interface AccessTokenClaims {
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly iss: string;
  readonly sub: string;
}

/**
 * Encodes one JWT segment.
 *
 * @param segment - The JWT header or claims.
 * @returns The base64url-encoded JSON.
 */
function encodeSegment(
  segment: AccessTokenClaims | { readonly alg: "HS256"; readonly typ: "JWT" }
): string {
  return Buffer.from(JSON.stringify(segment)).toString("base64url");
}

/**
 * Mints an HS256 JWT for one browser, with its own anonymous `visitor:<uuid>` subject.
 *
 * @returns The signed token, valid for {@link ACCESS_TOKEN_TTL_SECONDS}.
 * @throws {@link Error} When `EVE_ACCESS_PASSWORD` is not set.
 */
export function signAccessToken(): string {
  const password = accessPassword();
  if (password === undefined) {
    throw new Error("EVE_ACCESS_PASSWORD is not set.");
  }
  const now = Math.floor(Date.now() / 1000);
  const body = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment({
    aud: AUDIENCE,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    iat: now,
    iss: ISSUER,
    sub: `visitor:${randomUUID()}`,
  })}`;
  const signature = createHmac("sha256", signingKey(password))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

/**
 * Verifies a token minted by {@link signAccessToken} against the current password.
 *
 * @param token - The raw token, usually read from {@link ACCESS_COOKIE}.
 * @returns The visitor's auth context, or `undefined` when the token is missing,
 * invalid, expired, or no password is configured.
 */
export async function verifyAccessToken(
  token: string | undefined
): Promise<SessionAuthContext | undefined> {
  const password = accessPassword();
  if (password === undefined || token === undefined || token === "") {
    return undefined;
  }
  const result = await verifyJwtHmac(token, tokenConfig(password));
  return result.ok
    ? {
        ...result.sessionAuth,
        authenticator: "access-password",
        principalType: "user",
      }
    : undefined;
}

/**
 * Reads one cookie from a `Cookie` request header.
 *
 * @param header - The raw `Cookie` header value.
 * @param name - The cookie to find.
 * @returns The decoded cookie value, or `undefined` when absent or malformed.
 */
function readCookie(header: string | null, name: string): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Route auth for the web chat's access cookie. Place it after `localDev()` and
 * before `placeholderAuth()`.
 *
 * @returns An `AuthFn` that accepts same-origin requests with a valid access
 * cookie, and skips (returns `null`) when no password is configured so
 * `placeholderAuth()` can report that instead.
 * @throws {@link UnauthenticatedError} From the returned `AuthFn`, with code
 * `access_required`, when a password is set but the cookie is missing, invalid,
 * or sent cross-site. The chat turns this 401 into a sign-in redirect.
 *
 * @example
 * ```ts
 * eveChannel({ auth: [vercelOidc(), localDev(), accessCookieAuth(), placeholderAuth()] });
 * ```
 */
export function accessCookieAuth(): AuthFn {
  return async (request) => {
    if (!isAccessConfigured()) {
      return null;
    }
    const crossSite =
      request.headers.has("origin") &&
      request.headers.get("sec-fetch-site") !== "same-origin";
    const sessionAuth = crossSite
      ? undefined
      : await verifyAccessToken(
          readCookie(request.headers.get("cookie"), ACCESS_COOKIE)
        );
    if (sessionAuth) {
      return sessionAuth;
    }
    throw new UnauthenticatedError({
      code: "access_required",
      message: "Enter the access password to continue.",
    });
  };
}
