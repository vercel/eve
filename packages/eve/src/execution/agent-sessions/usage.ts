import { addTokenUsage } from "#shared/token-usage-math.js";
import type { TokenUsage } from "#shared/token-usage.js";

// A delegated agent's spend counts against the session that delegated to it.
// A run tallies what its `ctx.agent` sessions spend, and its replies and
// outcome carry the running total to its calling session, which records the
// new spend as a fact in the step that applies them. A `serve` run sends the total on its own only for
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
  let spent: TokenUsage | undefined;
  return {
    record(turnUsage) {
      spent = spent === undefined ? turnUsage : addTokenUsage(spent, turnUsage);
      onRecord?.();
    },
    total: () => spent,
  };
}
