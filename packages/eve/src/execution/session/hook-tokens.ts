import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";

/**
 * Every hook a session answers to, derived from its committed state: the
 * stable command inbox plus each continuation alias a channel handler
 * selected. This is the one source of truth for claims at boot, at every
 * state transition, and across a deployment handoff.
 */
export function sessionHookTokens(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: Pick<DurableSessionState, "continuationToken" | "sessionId">;
}): readonly string[] {
  const recorded = input.serializedContext[ContinuationHookTokensKey.name];
  const tokens = new Set<string>([sessionCommandHookToken(input.sessionState.sessionId)]);
  if (Array.isArray(recorded)) {
    for (const token of recorded)
      if (typeof token === "string" && token.length > 0) tokens.add(token);
  }
  if (input.sessionState.continuationToken !== "") tokens.add(input.sessionState.continuationToken);
  return [...tokens];
}
