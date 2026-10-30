import { createHmac, timingSafeEqual } from "node:crypto";

/** The cookie Tally's login form sets. Its value is `<base64url payload>.<base64url HMAC>`. */
export const SESSION_COOKIE = "tally_session";

export type Role = "owner" | "member";

export interface Session {
  userId: string;
  orgId: string;
  role: Role;
  name: string;
  email: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set. Copy .env.example to .env.local.");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Encodes a session as a signed cookie value. */
export function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verifies a signed cookie value. Returns `null` for a forged, malformed, or expired session. */
export function verifySessionToken(token: string | null | undefined): Session | null {
  if (!token) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

/** Reads and verifies the Tally session from a raw `Cookie` request header. */
export function readSession(cookieHeader: string | null | undefined): Session | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return verifySessionToken(decodeURIComponent(value.join("=")));
  }
  return null;
}
