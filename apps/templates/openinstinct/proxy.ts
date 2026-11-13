import { NextResponse, type NextRequest } from "next/server";
import { getAuthSession } from "@db/services/auth/session";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/sign-in" ||
    // The contact route verifies its signed URL; Linq downloads without cookies.
    pathname === "/contacts/openinstinct.vcf" ||
    pathname.startsWith("/api/auth/") ||
    pathname === "/eve/v1/health" ||
    pathname.startsWith("/internal/scheduled-run/") ||
    pathname === "/eve/v1/dev/schedules/dynamic"
  ) {
    return NextResponse.next();
  }

  if (await getAuthSession(request.headers)) return NextResponse.next();

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|fonts|favicon.ico|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$).*)",
  ],
};
