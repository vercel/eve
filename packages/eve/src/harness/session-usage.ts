/**
 * What a session has spent is what its `usage.recorded` facts record, as its view totals them:
 * session limits, the quota a delegated child inherits, the usage a child reports to its parent,
 * and the `$eve.*` turn tags all read it. Spend the facts miss is a bug in the facts. Private state
 * keeps only what no fact holds: the limits a granted continuation raised, and how much of the
 * session's spend a child already reported.
 */
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import {
  findRuntimeUsageLimitViolation,
  grantRuntimeUsageLimits,
  remainingRuntimeUsageQuota,
  resolveRuntimeUsageLimits,
  type SessionRuntimeUsageLimits,
  type SessionUsageLimitViolation,
} from "#harness/session-usage-limits.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { addTokenUsage, type TokenUsage, usageSince } from "#shared/token-usage.js";

export type { SessionRuntimeUsageLimits, SessionUsageLimitViolation };

const REPORTED_SESSION_USAGE_STATE_KEY = "eve.harness.reportedSessionUsage";
const SESSION_RUNTIME_USAGE_LIMIT_KEY = "eve.harness.sessionRuntimeTokenLimit";

export const NO_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * What the session has spent, delegated spend included, as its saved view records it. A step
 * that published since it started reads its own view instead (`step.view()`).
 */
export function sessionUsage(session: { readonly state?: SessionStateMap }): TokenUsage {
  return storedProjection(session.state).view.usage.total;
}

/**
 * What a turn's own model runs spent, its summary runs included. Delegated spend isn't the
 * turn's: the calls that delegated carry it.
 */
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

/**
 * The lifetime-usage ceilings in force, per axis; an axis the configured limit leaves uncapped is
 * absent. Before any granted continuation they're the configured limits; each grant re-anchors
 * them to the usage then plus the configured limit ({@link bumpSessionRuntimeUsageLimits}).
 */
export function getSessionRuntimeUsageLimits(
  session: Pick<HarnessSession, "limits" | "state">,
): SessionRuntimeUsageLimits {
  const stored = session.state?.[SESSION_RUNTIME_USAGE_LIMIT_KEY] as
    | SessionRuntimeUsageLimits
    | undefined;
  return resolveRuntimeUsageLimits({ configured: configuredSessionUsageLimits(session), stored });
}

/**
 * Raises the limits after a person grants a continuation: each capped axis to the usage now plus
 * the configured limit, so one grant buys one full window even after an overshoot. Every axis
 * moves together, so prompts don't follow back to back. The configured limits never change.
 */
export function bumpSessionRuntimeUsageLimits(
  session: HarnessSession,
  usage = sessionUsage(session),
): HarnessSession {
  const bumped = grantRuntimeUsageLimits({
    configured: configuredSessionUsageLimits(session),
    usage,
  });
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_RUNTIME_USAGE_LIMIT_KEY]: bumped satisfies SessionRuntimeUsageLimits,
    },
  };
}

/**
 * The quota left under the limits in force, per axis; `false` for an uncapped one. A delegated
 * child's budget comes out of it.
 */
export function getSessionRemainingUsageQuota(session: Pick<HarnessSession, "limits" | "state">): {
  costUsd: number | false;
  inputTokens: number | false;
  outputTokens: number | false;
} {
  return remainingRuntimeUsageQuota({
    runtime: getSessionRuntimeUsageLimits(session),
    usage: sessionUsage(session),
  });
}

export function getSessionUsageLimitViolation(
  session: Pick<HarnessSession, "limits" | "state">,
  usage = sessionUsage(session),
): SessionUsageLimitViolation | null {
  return findRuntimeUsageLimitViolation({
    configured: configuredSessionUsageLimits(session),
    runtime: getSessionRuntimeUsageLimits(session),
    usage,
  });
}

function configuredSessionUsageLimits(
  session: Pick<HarnessSession, "limits">,
): SessionRuntimeUsageLimits {
  return {
    costUsd: session.limits?.maxTokenCostUsdPerSession,
    inputTokens: session.limits?.maxInputTokensPerSession,
    outputTokens: session.limits?.maxOutputTokensPerSession,
  };
}

/**
 * What the session spent since the last take, which it now marks reported. A child reports it
 * to its parent when a turn settles or is cancelled, so the reports of a child that runs many
 * turns sum to what it spent.
 */
export function takeSessionUsageDelta<T extends { readonly state?: SessionStateMap }>(
  session: T,
): { readonly delta: TokenUsage; readonly session: T } {
  const total = sessionUsage(session);
  return {
    delta: usageSince(total, reportedUsage(session.state)),
    session: withReported(session, total),
  };
}

/**
 * Marks spend outside any turn, such as a compaction between turns, reported, so no turn's
 * report claims it.
 */
export function markUsageReported<T extends { readonly state?: SessionStateMap }>(
  session: T,
  usage: TokenUsage,
): T {
  return withReported(session, addTokenUsage(reportedUsage(session.state), usage));
}

/** The view with `usage` as everything it records spent, all of it on model runs. */
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
