import { countUsageByWindow, getSessionUsageWindowId } from "#harness/turn-tag-state.js";
import type { SessionStateMap } from "#harness/types.js";
import { addTokenUsage, type TokenUsage, type UsageByWindow } from "#shared/token-usage.js";

// A delegated agent's spend counts against the session that delegated to it.
// A run tallies what its `ctx.agent` sessions spend, and its replies and
// outcome carry the running total to its calling session, which counts it in
// the step that applies them. A `serve` run sends the total on its own only for
// a turn no reply will carry. A run's messages reach the session in the order
// it sent them, so each total is at least the last one counted. A child's
// usage already includes what its own children spent, so a chain of agents
// adds up at every level. Every total is split by the usage window it was
// spent in, as the spending session saw it, so a renewal and a report that
// cross in transit still count the spend against the right window.

/** What a run's `ctx.agent` sessions have spent, turn by turn. */
export interface RunUsageTally {
  /** Adds one ended turn's usage, split by the window each part was spent in. */
  record(windows: UsageByWindow): void;
  /** Whether a turn ended since the last {@link carry}. */
  hasUncarried(): boolean;
  /** The running totals for a message to the calling session, now carried; `undefined` before any turn ended. */
  carry(): RunUsage | undefined;
}

/** `onRecord` runs after each recorded turn, so the run can send a total no reply will carry. */
export function createRunUsageTally(onRecord?: () => void): RunUsageTally {
  let totals: RunUsage | undefined;
  let uncarried = false;
  return {
    record(windows) {
      for (const [windowId, spent] of Object.entries(windows)) {
        if (isZeroUsage(spent)) continue;
        const previous = totals?.windows?.[windowId];
        totals = {
          usage: totals === undefined ? spent : addTokenUsage(totals.usage, spent),
          windows: {
            ...totals?.windows,
            [windowId]: previous === undefined ? spent : addTokenUsage(previous, spent),
          },
        };
        uncarried = true;
      }
      onRecord?.();
    },
    hasUncarried() {
      return uncarried;
    },
    carry() {
      uncarried = false;
      return totals;
    },
  };
}

function isZeroUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheWriteTokens === 0 &&
    !usage.costUsd
  );
}

/** A run's running totals: all it spent, and the same spend by the window it was spent in. */
export interface RunUsage {
  readonly usage: TokenUsage;
  /** Absent from a run that predates windows: all of it was spent in the current one. */
  readonly windows?: UsageByWindow;
}

/**
 * Adds a run's delegated spend to the session's totals: its running totals,
 * less the part `counted` earlier, each window's part against that window.
 */
export function countRunUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  run: RunUsage,
  counted?: RunUsage,
): T {
  if (run.windows === undefined) {
    return countUsageByWindow(session, {
      [getSessionUsageWindowId(session)]: usageSince(run.usage, counted?.usage),
    });
  }
  return countUsageByWindow(
    session,
    Object.fromEntries(
      Object.entries(run.windows).map(([windowId, total]) => [
        windowId,
        usageSince(total, counted?.windows?.[windowId]),
      ]),
    ),
  );
}

function usageSince(total: TokenUsage, counted: TokenUsage | undefined): TokenUsage {
  if (counted === undefined) return total;
  return {
    cacheReadTokens: total.cacheReadTokens - counted.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - counted.cacheWriteTokens,
    costUsd: total.costUsd === undefined ? undefined : total.costUsd - (counted.costUsd ?? 0),
    inputTokens: total.inputTokens - counted.inputTokens,
    outputTokens: total.outputTokens - counted.outputTokens,
  };
}
