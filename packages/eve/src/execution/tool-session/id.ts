import { createHash } from "node:crypto";

import { TOOL_SESSION_KEY_MAX_LENGTH } from "#channel/invoke-tool.js";
import { principalIdentity } from "#channel/principal-identity.js";
import type { SessionAuthContext } from "#channel/types.js";

export const TOOL_SESSION_ID_PREFIX = "tool_session_";

export function isToolSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TOOL_SESSION_ID_PREFIX);
}

export function validateToolSessionKey(key: string): string | undefined {
  if (key.length === 0) return "The tool session key must not be empty.";
  if (key.length > TOOL_SESSION_KEY_MAX_LENGTH) {
    return `The tool session key must be at most ${TOOL_SESSION_KEY_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export function deriveToolSessionId(input: {
  readonly current: SessionAuthContext;
  readonly forwardedBy?: SessionAuthContext;
  readonly key: string;
}): string {
  const identity: unknown[] = ["eve.tool-session.v1", principalIdentity(input.current), input.key];
  if (input.forwardedBy !== undefined) identity.push(principalIdentity(input.forwardedBy));
  const encoded = JSON.stringify(identity);
  return `${TOOL_SESSION_ID_PREFIX}${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}
