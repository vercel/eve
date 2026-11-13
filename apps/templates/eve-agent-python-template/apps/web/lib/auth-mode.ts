import { isPasswordConfigured, verifyPasswordSessionToken } from "./password-auth";

/**
 * - `password`: EVE_CHAT_PASSWORD is set; every page and API route needs the session cookie.
 * - `local-dev`: no password while running `next dev` or `vercel dev`; everything is open.
 * - `unconfigured`: deployed without a password; the app fails closed.
 */
export type AuthMode = "password" | "local-dev" | "unconfigured";

export function getAuthMode(): AuthMode {
  if (isPasswordConfigured()) {
    return "password";
  }

  const vercelEnv = process.env.VERCEL_ENV;
  if (process.env.NODE_ENV === "development" && (!vercelEnv || vercelEnv === "development")) {
    return "local-dev";
  }

  return "unconfigured";
}

/**
 * The one access rule for pages, API routes, and Server Actions: open in local
 * dev, otherwise a valid password session cookie.
 */
export function isAuthorized(sessionToken: string | undefined): boolean {
  const mode = getAuthMode();
  return mode === "local-dev" || (mode === "password" && verifyPasswordSessionToken(sessionToken));
}
