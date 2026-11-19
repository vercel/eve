import { readBrowserSession } from "@/lib/browser/sessions";
import type { AccessScope } from "@/lib/auth/scope";

export async function requireOwnedBrowserSession(scope: AccessScope, sessionId: string) {
  const record = await readBrowserSession(scope, sessionId);
  if (!record) throw new Error("Browser session not found.");
  return record;
}
