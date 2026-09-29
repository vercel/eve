import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { WorkflowToolRunUsageMessage } from "#execution/tools/workflow/messages.js";
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
// Each turn of a `ctx.agent` session reports its usage to the run that opened
// the session, and the run reports its running total to its calling session,
// which folds it into its own session totals. A child's reported usage already
// includes what its own children spent, so a chain of agents adds up at every
// level.

const RUN_USAGE_STATE_KEY = "eve.agentSessions.runUsage";

/** The latest usage report the session applied from each run that sent one. */
type RunUsageLedger = Readonly<
  Record<string, Pick<WorkflowToolRunUsageMessage, "sequence" | "usage">>
>;

/** Reports each ended turn of a run's sessions, as the run's running total, to its calling session. */
export function createRunUsageReporter(
  run: Pick<WorkflowToolRunContext, "from" | "owner">,
): (turnUsage: TokenUsage) => Promise<void> {
  let sequence = 0;
  let spent: TurnUsageState | undefined;
  return async (turnUsage) => {
    sequence += 1;
    spent = accumulateSessionUsage({ previous: spent, usage: turnUsage });
    await run.owner.send({
      from: run.from,
      kind: "usage",
      sequence,
      usage: toUsage(spent.session),
    });
  };
}

/**
 * Adds what a run's report adds to the last one the session applied from that
 * run. A report no newer than that one adds nothing: it is a redelivery, or an
 * earlier report the applied one already includes.
 */
export function foldRunUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  report: Pick<WorkflowToolRunUsageMessage, "from" | "sequence" | "usage">,
): T {
  const ledger = readLedger(session.state);
  const { runId } = report.from;
  const applied = ledger[runId];
  if (applied !== undefined && report.sequence <= applied.sequence) return session;
  const folded = setTurnUsageState(
    session,
    accumulateSessionUsage({
      previous: getTurnUsageState(session.state),
      usage: usageSince(report.usage, applied?.usage),
    }),
  );
  return writeLedger(folded, {
    ...ledger,
    [runId]: { sequence: report.sequence, usage: report.usage },
  });
}

/** Whether the session applied a usage report from the run. */
export function hasRunUsage(state: SessionStateMap | undefined, runId: string): boolean {
  return readLedger(state)[runId] !== undefined;
}

/**
 * Drops a run's entry once the run has ended. A run sends its outcome only
 * after every other message, redeliveries included, so nothing from it follows.
 */
export function forgetRunUsage<T extends { readonly state?: SessionStateMap }>(
  session: T,
  runId: string,
): T {
  const ledger = readLedger(session.state);
  if (ledger[runId] === undefined) return session;
  const { [runId]: _ended, ...rest } = ledger;
  return writeLedger(session, rest);
}

function usageSince(total: TokenUsage, applied: TokenUsage | undefined): TokenUsageDelta {
  if (applied === undefined) return total;
  return {
    cacheReadTokens: total.cacheReadTokens - applied.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - applied.cacheWriteTokens,
    costUsd: total.costUsd === undefined ? undefined : total.costUsd - (applied.costUsd ?? 0),
    inputTokens: total.inputTokens - applied.inputTokens,
    outputTokens: total.outputTokens - applied.outputTokens,
  };
}

function readLedger(state: SessionStateMap | undefined): RunUsageLedger {
  return (state?.[RUN_USAGE_STATE_KEY] as RunUsageLedger | undefined) ?? {};
}

function writeLedger<T extends { readonly state?: SessionStateMap }>(
  session: T,
  ledger: RunUsageLedger,
): T {
  const state = { ...session.state };
  if (Object.keys(ledger).length === 0) delete state[RUN_USAGE_STATE_KEY];
  else state[RUN_USAGE_STATE_KEY] = ledger;
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}
