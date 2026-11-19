import { NextResponse } from "next/server";

import { isSameOrigin } from "../../../../lib/origin";
import {
  createPasswordSessionToken,
  PASSWORD_SESSION_COOKIE_NAME,
  PASSWORD_SESSION_MAX_AGE,
  verifyAppPassword,
} from "../../../../lib/password-auth";
import { countInWindow } from "../../../../lib/rate-limit";
import { getAuthMode } from "../../../../lib/setup";

/**
 * Wrong passwords an address may send in a window before it must wait. Only failures count, so
 * people signing in correctly from one network never use up each other's attempts. Guessing from
 * many addresses is bounded by the password itself, a generated secret; see lib/setup.ts.
 */
const FAILURES_PER_ADDRESS = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;

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

  const failures = {
    key: callerAddress(request),
    prefix: "login-failures",
    windowSeconds: FAILURE_WINDOW_SECONDS,
  };
  // Each attempt reserves a failure before the password is checked, atomically, so requests sent
  // at once can't all slip under the limit; a correct password gives its reservation back.
  const attempt = await countInWindow(failures);
  if (attempt.count > FAILURES_PER_ADDRESS) {
    const now = Math.floor(Date.now() / 1000);
    return NextResponse.json(
      { error: "Too many wrong passwords. Try again later." },
      {
        headers: { "retry-after": String(FAILURE_WINDOW_SECONDS - (now % FAILURE_WINDOW_SECONDS)) },
        status: 429,
      },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";
  if (!verifyAppPassword(password))
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  await attempt.release();

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
