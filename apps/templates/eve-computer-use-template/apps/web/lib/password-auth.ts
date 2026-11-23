import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/*
 * Starter access for one trusted operator: everyone who knows `EVE_COMPUTER_USE_PASSWORD` signs
 * in as the same user, held in an HMAC-signed cookie. From the chat and voice templates.
 */

export const PASSWORD_SESSION_COOKIE_NAME = "eve_computer_use_session";
export const PASSWORD_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const TOKEN_VERSION = "v1";

export function getAppPassword() {
  return process.env.EVE_COMPUTER_USE_PASSWORD?.trim() ?? "";
}

export function verifyAppPassword(candidate: string) {
  const expected = getAppPassword();

  if (!expected) {
    return false;
  }

  return timingSafeEqual(hash(candidate), hash(expected));
}

export function createPasswordSessionToken(now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + PASSWORD_SESSION_MAX_AGE;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  const signature = sign(payload);

  return `${payload}.${signature}`;
}

export function verifyPasswordSessionToken(token: string | undefined, now = Date.now()) {
  if (!token) {
    return false;
  }

  const [version, expiresAtRaw, signature, ...extra] = token.split(".");
  const expiresAt = Number(expiresAtRaw);

  if (
    version !== TOKEN_VERSION ||
    !signature ||
    extra.length > 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(now / 1000)
  ) {
    return false;
  }

  const expected = sign(`${version}.${expiresAt}`);

  return timingSafeEqual(hash(signature), hash(expected));
}

export function getPasswordSessionFromHeaders(headers: Headers) {
  const cookieHeader = headers.get("cookie");

  if (!cookieHeader) {
    return false;
  }

  const token = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim().split("="))
    .find(([name]) => name === PASSWORD_SESSION_COOKIE_NAME)?.[1];

  return verifyPasswordSessionToken(token ? decodeURIComponent(token) : undefined);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest();
}

function sign(payload: string) {
  return createHmac("sha256", getAppPassword()).update(payload).digest("base64url");
}
