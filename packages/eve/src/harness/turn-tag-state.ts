/**
 * Token-usage accumulator for `$eve.*` observability tags and session limits.
 * Lives on `session.state` so the totals survive workflow step boundaries the
 * way the rest of the harness state does.
 *
 * The harness runs each turn as a sequence of `"use step"` invocations
 * (one per tool-loop iteration). Each step knows its own
 * `result.usage`, but the dashboard cares about totals **per turn**.
 * The workflow runtime's attribute store is "last write wins" per key,
 * so the simplest cumulative pattern is: read the previous total from
 * `session.state`, add the new step's usage, write the running total
 * back. The most recent emit then carries the final per-turn total.
 *
 * `turnId` keys the turn totals so a fresh turn starts at zero without relying
 * on a separate "reset" code path. Session totals stay in the same state record
 * and keep accumulating until the durable session ends.
 *
 * `TokenUsageTotals` carries `sawCost` alongside the shared token and token-cost
 * fields so observability can distinguish an unreported cost from a reported
 * zero. {@link toUsage} drops that internal marker when a total crosses into
 * the shared {@link TokenUsage} contract.
 */
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import {
  findRuntimeUsageLimitViolation,
  grantRuntimeUsageLimits,
  remainingRuntimeUsageQuota,
  resolveRuntimeUsageLimits,
  type SessionRuntimeUsageLimits,
  type SessionUsageLimitViolation,
} from "#harness/session-usage-limits.js";
import type { TokenUsage } from "#shared/token-usage.js";

export type { SessionRuntimeUsageLimits, SessionUsageLimitViolation };

const HARNESS_TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";
const REPORTED_SESSION_USAGE_STATE_KEY = "eve.harness.reportedSessionUsage";
const SESSION_RUNTIME_USAGE_LIMIT_KEY = "eve.harness.sessionRuntimeTokenLimit";

export interface TokenUsageTotals {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly sawCost: boolean;
}

export type TokenUsageDelta = Partial<TokenUsageTotals>;

/**
 * Rolling token usage for the durable session and the in-flight turn.
 *
 * `turnId` is the in-flight turn's stable id; when the harness step
 * runs in a different turn, the flat turn totals reset. The nested
 * `session` totals do not reset.
 */
export interface TurnUsageState extends TokenUsageTotals {
  readonly session: TokenUsageTotals;
  readonly turnId: string;
}

const ZERO_TOKEN_USAGE: TokenUsageTotals = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  sawCost: false,
};

/** Reads the stored per-turn token state, or `undefined` when absent. */
export function getTurnUsageState(state: SessionStateMap | undefined): TurnUsageState | undefined {
  return state?.[HARNESS_TURN_USAGE_STATE_KEY] as TurnUsageState | undefined;
}

export function getSessionTokenUsage(session: Pick<HarnessSession, "state">): TokenUsageTotals {
  return getTurnUsageState(session.state)?.session ?? ZERO_TOKEN_USAGE;
}

/** Projects a {@link TokenUsageTotals} down to the cross-cutting {@link TokenUsage} shape. */
export function toUsage(totals: TokenUsageTotals): TokenUsage {
  return {
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsd: totals.sawCost ? totals.costUsd : undefined,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
  };
}

/**
 * The lifetime-usage ceilings currently in force, per axis. An axis is
 * absent when the configured limit leaves it uncapped. Before any granted
 * continuation the runtime limit equals the configured limit; each grant
 * re-anchors it to `usage + configured limit` via
 * {@link bumpSessionRuntimeUsageLimits}.
 */
export function getSessionRuntimeUsageLimits(
  session: Pick<HarnessSession, "limits" | "state">,
): SessionRuntimeUsageLimits {
  const stored = session.state?.[SESSION_RUNTIME_USAGE_LIMIT_KEY] as
    | SessionRuntimeUsageLimits
    | undefined;
  return resolveRuntimeUsageLimits({
    configured: configuredSessionUsageLimits(session),
    stored,
  });
}

/**
 * Bumps the runtime usage limits after the user grants a continuation. Each
 * capped axis is re-anchored to `current usage + configured limit`, so one
 * approval buys one full configured window even after an overshoot. All axes
 * bump together to avoid back-to-back prompts. Configured limits never change.
 */
export function bumpSessionRuntimeUsageLimits(session: HarnessSession): HarnessSession {
  const usage = getSessionTokenUsage(session);
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
 * Remaining lifetime usage quota under the runtime limits, per axis.
 * `false` marks an uncapped axis. This is the pool a delegated child's
 * budget is granted from.
 */
export function getSessionRemainingUsageQuota(session: Pick<HarnessSession, "limits" | "state">): {
  costUsd: number | false;
  inputTokens: number | false;
  outputTokens: number | false;
} {
  const usage = getSessionTokenUsage(session);
  const runtime = getSessionRuntimeUsageLimits(session);
  return remainingRuntimeUsageQuota({ runtime, usage });
}

export function getSessionUsageLimitViolation(
  session: Pick<HarnessSession, "limits" | "state">,
): SessionUsageLimitViolation | null {
  const usage = getSessionTokenUsage(session);
  const runtime = getSessionRuntimeUsageLimits(session);
  return findRuntimeUsageLimitViolation({
    configured: configuredSessionUsageLimits(session),
    runtime,
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
 * Takes the session-usage delta accumulated since the previous take and
 * marks it reported.
 *
 * Persisted on `session.state` (not in step-local memory) so the entry
 * snapshot survives `"use step"` boundaries: the totals at the previous
 * settled turn are the totals at this turn's entry, because a parked child
 * runs no model calls in between. Blocked parks (authorization, queued
 * input) between two settlements never lose usage — the delta always
 * measures everything since the last report, so the deltas of a
 * multi-turn persistent child sum exactly to its session totals.
 */
export function takeSessionUsageDelta(session: HarnessSession): {
  readonly delta: TokenUsage;
  readonly session: HarnessSession;
} {
  const totals = getSessionTokenUsage(session);
  const reported =
    (session.state?.[REPORTED_SESSION_USAGE_STATE_KEY] as TokenUsageTotals | undefined) ??
    ZERO_TOKEN_USAGE;
  return {
    delta: {
      cacheReadTokens: totals.cacheReadTokens - reported.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - reported.cacheWriteTokens,
      costUsd: totals.sawCost || reported.sawCost ? totals.costUsd - reported.costUsd : undefined,
      inputTokens: totals.inputTokens - reported.inputTokens,
      outputTokens: totals.outputTokens - reported.outputTokens,
    },
    session: {
      ...session,
      state: {
        ...session.state,
        [REPORTED_SESSION_USAGE_STATE_KEY]: totals,
      },
    },
  };
}

/** Writes per-turn token state onto a new copy of the session. */
export function setTurnUsageState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  next: TurnUsageState,
): T {
  return {
    ...session,
    state: {
      ...session.state,
      [HARNESS_TURN_USAGE_STATE_KEY]: next,
    },
  };
}

/**
 * Folds one step's `usage` into the running per-turn totals. When
 * `turnId` differs from the stored state (e.g. a new turn just
 * started), the previous totals are discarded — fresh turns start at
 * zero without an explicit reset path.
 */
export function accumulateTurnUsage(input: {
  readonly previous: TurnUsageState | undefined;
  readonly turnId: string;
  readonly usage: TokenUsageDelta | undefined;
}): TurnUsageState {
  const delta = toTokenUsageDelta(input.usage);
  const previousSession = input.previous?.session ?? ZERO_TOKEN_USAGE;
  const turnBase =
    input.previous !== undefined && input.previous.turnId === input.turnId
      ? input.previous
      : ZERO_TOKEN_USAGE;

  return {
    ...addTokenUsage(turnBase, delta),
    turnId: input.turnId,
    session: addTokenUsage(previousSession, delta),
  };
}

/**
 * Folds a delegated child session's reported totals into the parent's
 * session totals without touching the in-flight turn totals. Turn tags
 * attribute only the parent's own model calls (child spend is attributed by
 * the caller's durable `agent.action` span); session totals feed the session
 * token limits and the remaining-quota budget granted to later delegations.
 */
export function accumulateSessionUsage(input: {
  readonly previous: TurnUsageState | undefined;
  readonly usage: TokenUsageDelta;
}): TurnUsageState {
  const delta = toTokenUsageDelta(input.usage);
  const base = input.previous ?? {
    ...ZERO_TOKEN_USAGE,
    session: ZERO_TOKEN_USAGE,
    turnId: "",
  };

  return {
    ...base,
    session: addTokenUsage(base.session, delta),
  };
}

function addTokenUsage(base: TokenUsageTotals, delta: TokenUsageTotals): TokenUsageTotals {
  return {
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
    costUsd: base.costUsd + delta.costUsd,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    sawCost: base.sawCost || delta.sawCost,
  };
}

function toTokenUsageDelta(usage: TokenUsageDelta | undefined): TokenUsageTotals {
  if (usage === undefined) {
    return ZERO_TOKEN_USAGE;
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    costUsd: usage.costUsd ?? 0,
    inputTokens,
    outputTokens,
    sawCost: usage.costUsd !== undefined,
  };
}
