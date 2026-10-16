import { usageOf } from "#harness/facts.js";
import { SESSION_PROJECTION_STATE_KEY, storedProjection } from "#harness/session-machine/view.js";
import { withModelUsage } from "#harness/session-usage.js";
import type { SessionStateMap } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The session with `usage` as what its view records it spent, as model usage. */
export function withSessionUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: Partial<TokenUsage>,
): T {
  const projection = storedProjection(session.state);
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_PROJECTION_STATE_KEY]: {
        ...projection,
        view: withModelUsage(projection.view, usageOf(usage)),
      },
    },
  };
}
