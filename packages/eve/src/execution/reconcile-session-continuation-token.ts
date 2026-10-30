import type { ContextAccessor } from "#context/key.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { HarnessSessionBase } from "#harness/types.js";

/** Re-stamps a session after a channel handler selects a new current continuation address. */
export function reconcileSessionContinuationToken<S extends HarnessSessionBase>(
  ctx: ContextAccessor,
  session: S,
): S {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}
