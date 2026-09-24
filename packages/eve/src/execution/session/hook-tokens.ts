import { ContinuationHookTokensKey } from "#context/keys.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import type { SessionStateMap } from "#harness/types.js";
import { readTaskCallbackAlias } from "#tasks/state.js";

/**
 * Every hook a session answers to, derived from its committed state: the
 * stable command inbox, each continuation alias a channel handler
 * selected, and the callback alias remote children report to. This is the one source of truth for claims at boot, at every
 * state transition, and across a deployment handoff.
 */
export function sessionHookTokens(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: Pick<DurableSessionState, "continuationToken" | "sessionId"> & {
    readonly snapshot?: { readonly session: { readonly state?: SessionStateMap } };
  };
}): readonly string[] {
  const recorded = input.serializedContext[ContinuationHookTokensKey.name];
  const tokens = new Set<string>([sessionCommandHookToken(input.sessionState.sessionId)]);
  if (Array.isArray(recorded)) {
    for (const token of recorded)
      if (typeof token === "string" && token.length > 0) tokens.add(token);
  }
  if (input.sessionState.continuationToken !== "") tokens.add(input.sessionState.continuationToken);
  const callbackAlias = readTaskCallbackAlias(input.sessionState.snapshot?.session.state);
  if (callbackAlias !== undefined) tokens.add(callbackAlias);
  return [...tokens];
}
