import type { ContextReader } from "#context/provider.js";
import { ParentSessionKey, SessionCallbackKey } from "#context/keys.js";

/**
 * True when a parent, local or remote, delegated this session, whether or not
 * it relays the session's input requests.
 */
export function isDelegatedSessionContext(serializedContext: Record<string, unknown>): boolean {
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

/** {@link isDelegatedSessionContext} for the live context of a running turn. */
export function hasDelegatedCaller(ctx: ContextReader): boolean {
  return ctx.get(ParentSessionKey) !== undefined || ctx.get(SessionCallbackKey) !== undefined;
}
