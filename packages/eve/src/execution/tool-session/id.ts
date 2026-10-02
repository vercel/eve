import { createHash } from "node:crypto";

import { TOOL_SESSION_KEY_MAX_LENGTH } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";

/**
 * Prefix of every keyed tool session id. Sandbox bindings read it to name and
 * find tool-session sandboxes, since a tool session keeps no record of its own.
 */
export const TOOL_SESSION_ID_PREFIX = "tool_session_";

export function isToolSessionId(sessionId: string): boolean {
  return sessionId.startsWith(TOOL_SESSION_ID_PREFIX);
}

/** Why a tool session key was refused, or `undefined` when it is usable. */
export function validateToolSessionKey(key: string): string | undefined {
  if (key.length === 0) return "The tool session key must not be empty.";
  if (key.length > TOOL_SESSION_KEY_MAX_LENGTH) {
    return `The tool session key must be at most ${TOOL_SESSION_KEY_MAX_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * Derives a keyed tool session id from the caller and the key. Nothing is
 * stored: every call recomputes the id from its authenticated principal, so
 * another caller sending the same key reaches a different session.
 *
 * `forwarder` is reserved for a channel that calls on behalf of an end user,
 * so two users behind one forwarder stay apart; nothing passes it yet.
 */
export function deriveToolSessionId(input: {
  readonly current: SessionAuthContext;
  readonly forwarder?: SessionAuthContext;
  readonly key: string;
}): string {
  const encoded = JSON.stringify([
    "eve.tool-session.v1",
    input.forwarder === undefined ? null : principalIdentity(input.forwarder),
    principalIdentity(input.current),
    input.key,
  ]);
  return `${TOOL_SESSION_ID_PREFIX}${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

// Attributes describe a principal; they do not identify it.
function principalIdentity(auth: SessionAuthContext): readonly string[] {
  return [
    auth.authenticator,
    auth.issuer ?? "",
    auth.principalType,
    auth.principalId,
    auth.subject ?? "",
  ];
}
