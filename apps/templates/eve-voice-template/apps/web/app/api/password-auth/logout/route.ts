import { NextResponse } from "next/server";
import { hasSameOriginRequest, PASSWORD_SESSION_COOKIE_NAME } from "@/lib/password-auth";

export async function POST(request: Request) {
  if (!hasSameOriginRequest(request)) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

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
