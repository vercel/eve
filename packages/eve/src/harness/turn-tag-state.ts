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
 * `TokenUsageTotals` carries `costUsd`/`sawCost` alongside the token counts
 * for the `$eve.*` dashboard tags and session limits — fields the
 * cross-cutting {@link TokenUsage} contract (subagent results, callback
 * bodies, usage spans) does not carry. {@link toUsage} projects a total down
 * to that shared shape at the one site (the driver's `done` action) where a
 * session total crosses into it.
 */
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

const HARNESS_TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";
const SESSION_TOKEN_BUDGET_BASELINE_KEY = "eve.harness.sessionTokenBudgetBaseline";

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

export type SessionTokenLimitViolation =
  | {
      readonly kind: "input";
      readonly limit: number;
      readonly usedTokens: number;
    }
  | {
      readonly kind: "output";
      readonly limit: number;
      readonly usedTokens: number;
    };

export function getSessionTokenUsage(session: Pick<HarnessSession, "state">): TokenUsageTotals {
  return getTurnUsageState(session.state)?.session ?? ZERO_TOKEN_USAGE;
}

/** Projects a {@link TokenUsageTotals} down to the cross-cutting {@link TokenUsage} shape. */
export function toUsage(totals: TokenUsageTotals): TokenUsage {
  return {
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
  };
}

/**
 * Usage totals recorded when the user last granted a session token budget
 * continuation. Limits are checked against usage measured from this
 * baseline, so each grant opens a fresh window of the configured size.
 */
interface SessionTokenBudgetBaseline {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const ZERO_BUDGET_BASELINE: SessionTokenBudgetBaseline = {
  inputTokens: 0,
  outputTokens: 0,
};

function getSessionTokenBudgetBaseline(
  state: SessionStateMap | undefined,
): SessionTokenBudgetBaseline {
  return (
    (state?.[SESSION_TOKEN_BUDGET_BASELINE_KEY] as SessionTokenBudgetBaseline | undefined) ??
    ZERO_BUDGET_BASELINE
  );
}

/**
 * Resets the session token budget windows to the current usage totals.
 *
 * Called when the user grants a continuation after a session token limit was
 * reached. The configured limits keep their values and act as the size of the
 * next budget window, measured from the moment of the grant. Both windows
 * reset together so a session near two limits gets one prompt, not two
 * back-to-back.
 */
export function extendSessionTokenBudget(session: HarnessSession): HarnessSession {
  const usage = getSessionTokenUsage(session);
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_TOKEN_BUDGET_BASELINE_KEY]: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      } satisfies SessionTokenBudgetBaseline,
    },
  };
}

export function getSessionTokenLimitViolation(
  session: Pick<HarnessSession, "limits" | "state">,
): SessionTokenLimitViolation | null {
  const usage = getSessionTokenUsage(session);
  const baseline = getSessionTokenBudgetBaseline(session.state);
  const maxInputTokensPerSession = session.limits?.maxInputTokensPerSession;
  const maxOutputTokensPerSession = session.limits?.maxOutputTokensPerSession;
  const inputTokensInWindow = usage.inputTokens - baseline.inputTokens;
  const outputTokensInWindow = usage.outputTokens - baseline.outputTokens;
  if (maxInputTokensPerSession !== undefined && inputTokensInWindow >= maxInputTokensPerSession) {
    return {
      kind: "input",
      limit: maxInputTokensPerSession,
      usedTokens: inputTokensInWindow,
    };
  }
  if (
    maxOutputTokensPerSession !== undefined &&
    outputTokensInWindow >= maxOutputTokensPerSession
  ) {
    return {
      kind: "output",
      limit: maxOutputTokensPerSession,
      usedTokens: outputTokensInWindow,
    };
  }
  return null;
}

/** Writes per-turn token state onto a new copy of the session. */
export function setTurnUsageState(session: HarnessSession, next: TurnUsageState): HarnessSession {
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
 * the caller-side `invoke_agent` span); session totals feed the session
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
