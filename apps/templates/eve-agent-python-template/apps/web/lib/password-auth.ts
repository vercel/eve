import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed session cookie for the optional shared password (EVE_CHAT_PASSWORD).
 *
 * Shared by the web app (login + proxy gate) and the eve channel
 * (`agent/channels/eve.ts`), so one cookie authenticates both services on the
 * same origin. Adapted from vercel/eve's eve-chat-template.
 */
export const PASSWORD_SESSION_COOKIE_NAME = "eve_session";
export const PASSWORD_SESSION_MAX_AGE = 60 * 60 * 24 * 30;

const TOKEN_VERSION = "v1";

export function getChatPassword(): string {
  return process.env.EVE_CHAT_PASSWORD?.trim() ?? "";
}

export function isPasswordConfigured(): boolean {
  return getChatPassword().length > 0;
}

export function verifyChatPassword(candidate: string): boolean {
  const expected = getChatPassword();
  if (!expected) {
    return false;
  }
  return timingSafeEqual(hash(candidate), hash(expected));
}

export function createPasswordSessionToken(now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + PASSWORD_SESSION_MAX_AGE;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyPasswordSessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token || !isPasswordConfigured()) {
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

  return timingSafeEqual(hash(signature), hash(sign(`${version}.${expiresAt}`)));
}

export function getPasswordSessionFromHeaders(headers: Headers): boolean {
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PASSWORD_SESSION_COOKIE_NAME}=`));

  return verifyPasswordSessionToken(
    cookie ? safeDecode(cookie.slice(PASSWORD_SESSION_COOKIE_NAME.length + 1)) : undefined,
  );
}

/** A malformed escape (e.g. `%E0%A4`) means no session, not a thrown request. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", getChatPassword()).update(payload).digest("base64url");
}
