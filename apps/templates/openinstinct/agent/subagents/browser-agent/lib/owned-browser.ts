import { readBrowserSession } from "@db/services/browsers";
import type { AccessScope } from "@shared/identity/access-scope";

export async function requireOwnedBrowserSession(
  scope: AccessScope,
  sessionId: string
) {
  const record = await readBrowserSession(scope, sessionId);
  if (!record) throw new Error("Browser session not found.");
  return record;
}
