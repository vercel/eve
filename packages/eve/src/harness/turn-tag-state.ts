/**
 * Per-turn rolling token-usage accumulator for `$eve.*` observability
 * tags. Lives on `session.state` so the totals survive workflow step
 * boundaries the way the rest of the harness state does.
 *
 * The harness runs each turn as a sequence of `"use step"` invocations
 * (one per tool-loop iteration). Each step knows its own
 * `result.usage`, but the dashboard cares about totals **per turn**.
 * The workflow runtime's attribute store is "last write wins" per key,
 * so the simplest cumulative pattern is: read the previous total from
 * `session.state`, add the new step's usage, write the running total
 * back. The most recent emit then carries the final per-turn total.
 *
 * `turnId` keys the state so a fresh turn starts at zero without
 * relying on a separate "reset" code path — when the harness moves to
 * a new turn, the stale totals are discarded automatically.
 */
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const HARNESS_TURN_USAGE_STATE_KEY = "eve.harness.turnUsage";

/**
 * Rolling token usage for the in-flight turn.
 *
 * `turnId` is the in-flight turn's stable id; when the harness step
 * runs in a different turn (or with the empty-string between-turns
 * sentinel), totals are reset.
 */
export interface TurnUsageState {
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turnId: string;
}

const ZERO_USAGE: Omit<TurnUsageState, "turnId"> = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** Reads the stored per-turn token state, or `undefined` when absent. */
export function getTurnUsageState(state: SessionStateMap | undefined): TurnUsageState | undefined {
  return state?.[HARNESS_TURN_USAGE_STATE_KEY] as TurnUsageState | undefined;
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
  readonly usage: {
    readonly cachedInputTokens?: number;
    readonly inputTokens?: number;
    readonly inputTokenDetails?: {
      readonly cacheWriteTokens?: number;
    };
    readonly outputTokens?: number;
  };
}): TurnUsageState {
  const base =
    input.previous !== undefined && input.previous.turnId === input.turnId
      ? input.previous
      : { ...ZERO_USAGE, turnId: input.turnId };

  return {
    turnId: input.turnId,
    cacheReadTokens: base.cacheReadTokens + (input.usage.cachedInputTokens ?? 0),
    cacheWriteTokens:
      base.cacheWriteTokens + (input.usage.inputTokenDetails?.cacheWriteTokens ?? 0),
    inputTokens: base.inputTokens + (input.usage.inputTokens ?? 0),
    outputTokens: base.outputTokens + (input.usage.outputTokens ?? 0),
  };
}
