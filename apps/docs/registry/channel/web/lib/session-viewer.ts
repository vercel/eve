import type { SessionOwner } from "./session-store.ts";

// Sign in with Vercel replaces this adapter. Custom apps must verify their own
// browser session here; deployment OIDC credentials are not a browser user.
export async function sessionViewer(_request: Request): Promise<SessionOwner | null> {
  return null;
}
