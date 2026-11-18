import { storedProjection } from "#harness/session-machine/view.js";
import type { SessionStateMap } from "#harness/types.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { addTokenUsage, usageSince } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";

const REPORTED_SESSION_USAGE_STATE_KEY = "eve.harness.reportedSessionUsage";

export const NO_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export function sessionUsage(session: { readonly state?: SessionStateMap }): TokenUsage {
  return storedProjection(session.state).view.usage.total;
}

export function turnUsage(view: SessionView, turnId: string): TokenUsage {
  let total = NO_USAGE;
  for (const run of Object.values(view.runs)) {
    if (run.usage === undefined) continue;
    const { owner } = run;
    const turn = "turnId" in owner ? owner.turnId : view.changes[owner.changeId]?.turnId;
    if (turn === turnId) total = addTokenUsage(total, run.usage);
  }
  return total;
}

export function takeSessionUsageDelta<T extends { readonly state?: SessionStateMap }>(
  session: T,
): { readonly delta: TokenUsage; readonly session: T } {
  const total = sessionUsage(session);
  return {
    delta: usageSince(total, reportedUsage(session.state)),
    session: withReported(session, total),
  };
}

export function markUsageReported<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsage,
): T {
  return withReported(session, addTokenUsage(reportedUsage(session.state), usage));
}

export function withModelUsage(view: SessionView, usage: TokenUsage): SessionView {
  return { ...view, usage: { byKind: { model: usage }, total: usage } };
}

function reportedUsage(state: SessionStateMap | undefined): TokenUsage {
  return (state?.[REPORTED_SESSION_USAGE_STATE_KEY] as TokenUsage | undefined) ?? NO_USAGE;
}

function withReported<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsage,
): T {
  return { ...session, state: { ...session.state, [REPORTED_SESSION_USAGE_STATE_KEY]: usage } };
}
