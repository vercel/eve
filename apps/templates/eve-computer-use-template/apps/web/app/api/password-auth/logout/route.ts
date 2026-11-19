import { NextResponse } from "next/server";

import { PASSWORD_SESSION_COOKIE_NAME } from "../../../../lib/password-auth";
import { isSameOrigin } from "../../caller";

/** `POST`: signs out by clearing the password session. */
export async function POST(request: Request) {
  if (request.headers.get("origin") === null || !isSameOrigin(request))
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(PASSWORD_SESSION_COOKIE_NAME, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
  });
  return response;
}
