import type { ContextAccessor } from "#context/key.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";

/** Re-stamps a session after a channel handler changes its continuation token. */
export function reconcileSessionContinuationToken(
  ctx: ContextAccessor,
  session: HarnessSession,
): HarnessSession {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}
