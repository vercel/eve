import { NextResponse } from "next/server";

import {
  createPasswordSessionToken,
  PASSWORD_SESSION_COOKIE_NAME,
  PASSWORD_SESSION_MAX_AGE,
  verifyAppPassword,
} from "../../../../lib/password-auth";
import { getAuthMode } from "../../../../lib/setup";
import { isSameOrigin } from "../../caller";

/** `POST { "password": "…" }`: signs in with `EVE_COMPUTER_USE_PASSWORD`. */
export async function POST(request: Request) {
  if (getAuthMode() !== "password")
    return NextResponse.json({ error: "Password sign-in is not configured." }, { status: 409 });
  if (request.headers.get("origin") === null || !isSameOrigin(request))
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });

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
