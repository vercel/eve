import { NextResponse } from "next/server";

import {
  createPasswordSessionToken,
  PASSWORD_SESSION_COOKIE_NAME,
  PASSWORD_SESSION_MAX_AGE,
  verifyAppPassword,
} from "../../../../lib/password-auth";
import { enforceRateLimit, RateLimitError } from "../../../../lib/rate-limit";
import { getAuthMode } from "../../../../lib/setup";
import { isSameOrigin } from "../../../../lib/origin";

/** Sign-in attempts each caller may make in a window, and all callers together in an hour. */
const ATTEMPTS_PER_CALLER = 10;
const CALLER_WINDOW_SECONDS = 15 * 60;
const ATTEMPTS_PER_DEPLOYMENT = 300;

/**
 * The caller's address as Vercel's proxy, or `vercel dev`, reports it; both overwrite any value
 * the caller sends.
 */
function callerAddress(request: Request): string {
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** `POST { "password": "…" }`: signs in with `EVE_COMPUTER_USE_PASSWORD`. */
export async function POST(request: Request) {
  if (getAuthMode() !== "password")
    return NextResponse.json({ error: "Password sign-in is not configured." }, { status: 409 });
  if (request.headers.get("origin") === null || !isSameOrigin(request))
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

  // Every attempt counts, whether or not the password turns out to be right.
  try {
    await enforceRateLimit({
      key: callerAddress(request),
      limit: ATTEMPTS_PER_CALLER,
      prefix: "login",
      windowSeconds: CALLER_WINDOW_SECONDS,
    });
    await enforceRateLimit({
      key: "all",
      limit: ATTEMPTS_PER_DEPLOYMENT,
      prefix: "login-all",
      windowSeconds: 60 * 60,
    });
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later." },
      { headers: { "retry-after": String(error.retryAfter) }, status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!verifyAppPassword(password))
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_SESSION_COOKIE_NAME, createPasswordSessionToken(), {
    httpOnly: true,
    maxAge: PASSWORD_SESSION_MAX_AGE,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
  });
  return response;
}
