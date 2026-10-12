import type { SessionStateMap } from "#harness/types.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The session with `usage` as what its view records it spent, as model usage. */
export function withSessionUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: Partial<TokenUsage>,
): T {
  const total: TokenUsage = {
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }),
  };
  const projection = storedProjection(session.state);
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_PROJECTION_STATE_KEY]: {
        ...projection,
        view: { ...projection.view, usage: { byKind: { model: total }, total } },
      },
    },
  };
}
