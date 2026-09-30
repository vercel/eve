import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
  toUsage,
  type TokenUsageDelta,
  type TurnUsageState,
} from "#harness/turn-tag-state.js";
import type { SessionStateMap } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

// A delegated agent's spend counts against the session that delegated to it.
// A run tallies what its `ctx.agent` sessions spend, and its replies and
// outcome carry the running total to its calling session, which counts it in
// the step that applies them. A `serve` run sends the total on its own only for
// a turn no reply will carry. A run's messages reach the session in the order
// it sent them, so each total is at least the last one counted. A child's
// usage already includes what its own children spent, so a chain of agents
// adds up at every level.

/** What a run's `ctx.agent` sessions have spent, turn by turn. */
export interface RunUsageTally {
  /** Adds one ended turn's usage. */
  record(turnUsage: TokenUsage): void;
  /** The running total, or `undefined` before any turn ended. */
  total(): TokenUsage | undefined;
}

/** `onRecord` runs after each recorded turn, so the run can send a total no reply will carry. */
export function createRunUsageTally(onRecord?: () => void): RunUsageTally {
  let spent: TurnUsageState | undefined;
  return {
    record(turnUsage) {
      spent = accumulateSessionUsage({ previous: spent, usage: turnUsage });
      onRecord?.();
    },
    total() {
      return spent === undefined ? undefined : toUsage(spent.session);
    },
  };
}

/**
 * Adds a run's delegated spend to the session's totals: its running `total`,
 * less the part of it `counted` earlier.
 */
export function countRunUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  total: TokenUsage,
  counted?: TokenUsage,
): T {
  return setTurnUsageState(
    session,
    accumulateSessionUsage({
      previous: getTurnUsageState(session.state),
      usage: usageSince(total, counted),
    }),
  );
}

function usageSince(total: TokenUsage, counted: TokenUsage | undefined): TokenUsageDelta {
  if (counted === undefined) return total;
  return {
    cacheReadTokens: total.cacheReadTokens - counted.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - counted.cacheWriteTokens,
    costUsd: total.costUsd === undefined ? undefined : total.costUsd - (counted.costUsd ?? 0),
    inputTokens: total.inputTokens - counted.inputTokens,
    outputTokens: total.outputTokens - counted.outputTokens,
  };
}
