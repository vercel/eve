import "server-only";

import { cookies } from "next/headers";
import { connection } from "next/server";
import { isAuthorized } from "./auth-mode";
import { PASSWORD_SESSION_COOKIE_NAME, verifyPasswordSessionToken } from "./password-auth";

// Not a "use server" module: every export there would become a callable action.

async function getSessionToken(): Promise<string | undefined> {
  // Token checks read the clock, so they must run at request time, never in a prerender.
  await connection();
  return (await cookies()).get(PASSWORD_SESSION_COOKIE_NAME)?.value;
}

/**
 * Whether this request may use the app: the same rule `proxy.ts` applies. Check
 * it first in every Server Action: actions are reachable by id from any route,
 * so `proxy.ts` alone isn't enough.
 */
export async function hasAccess(): Promise<boolean> {
  return isAuthorized(await getSessionToken());
}


/** Whether the browser is signed in with the shared password (not just local dev). */
export async function hasPasswordSession(): Promise<boolean> {
  return verifyPasswordSessionToken(await getSessionToken());
}
