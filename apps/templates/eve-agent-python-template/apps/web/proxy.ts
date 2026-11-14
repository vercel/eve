import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "./lib/auth-mode";
import { PASSWORD_SESSION_COOKIE_NAME } from "./lib/password-auth";

/**
 * Gates every Next.js page and API route behind the shared password.
 * `/eve/v1/*` never reaches Next.js: Vercel routes it to the eve service, whose
 * channel (`agent/channels/eve.ts`) checks the same cookie.
 */
export function proxy(request: NextRequest) {
  if (isAuthorized(request.cookies.get(PASSWORD_SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

// Exclusions are whole paths or segments (plus /login's RSC and prefetch variants),
// so `/logins` or `/icon.svg-data` stay gated.
export const config = {
  matcher: [
    "/((?!login(?:/|$|\\.rsc$|\\.segments/)|_next/static/|_next/image(?:/|$)|favicon\\.ico$|icon\\.svg$).*)",
  ],
};
