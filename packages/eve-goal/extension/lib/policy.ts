import type { GoalVerdict } from "./judge.ts";
import type { Goal } from "./state.ts";

/** Follow-up turns in a row without a tool call before a goal pauses. */
export const MAX_IDLE_RUNS = 2;

/** What a settled turn showed, read from the session view. */
export interface SettledTurn {
  readonly outcome: "completed" | "failed" | "cancelled";
  /** The turn ran on the goal's own follow-up, with no one else's input. */
  readonly followedUp: boolean;
  readonly toolCalls: number;
  /** Session spend so far, in US dollars, when the provider reported it. */
  readonly costUsd: number | undefined;
}

export type Check =
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "judge"; readonly idleRuns: number };

/** The guards before the judge: a turn that didn't complete, or one that made no progress. */
export function check(current: Goal, turn: SettledTurn): Check {
  if (turn.outcome !== "completed") {
    return { kind: "pause", reason: `The turn ${turn.outcome}.` };
  }
  const idleRuns = turn.followedUp && turn.toolCalls === 0 ? current.idleRuns + 1 : 0;
  if (idleRuns >= MAX_IDLE_RUNS) {
    return {
      kind: "pause",
      reason: `${MAX_IDLE_RUNS} follow-up turns in a row made no tool calls.`,
    };
  }
  return { idleRuns, kind: "judge" };
}

/**
 * The goal after the judge's verdict, and the message that continues it, if it goes on. Every
 * turn is judged, so one that finishes the work at a limit is still met; the run and spend
 * limits only stop the next follow-up.
 */
export function settle(
  current: Goal,
  verdict: GoalVerdict | undefined,
  turn: Pick<SettledTurn, "costUsd"> & { readonly idleRuns: number },
  limits: { readonly maxCostUsd?: number },
): { readonly goal: Goal; readonly message?: string } {
  if (verdict === undefined) return { goal: pause(current, "The goal judge failed.") };
  if (verdict.verdict !== "continue") {
    return { goal: { ...current, lastReason: verdict.reason, status: verdict.verdict } };
  }
  if (current.runs >= current.maxRuns) {
    return { goal: pause(current, `The goal reached its limit of ${current.maxRuns} runs.`) };
  }
  const spent = spentUsd(current, turn.costUsd);
  if (limits.maxCostUsd !== undefined && spent >= limits.maxCostUsd) {
    return {
      goal: pause(
        current,
        `The goal spent $${spent.toFixed(2)} of its $${limits.maxCostUsd.toFixed(2)} budget.`,
      ),
    };
  }
  return {
    goal: {
      ...current,
      followedUp: true,
      idleRuns: turn.idleRuns,
      lastReason: verdict.reason,
      runs: current.runs + 1,
    },
    message: `Continue working toward the goal. ${verdict.reason}`,
  };
}

export function pause(current: Goal, reason: string): Goal {
  return { ...current, followedUp: false, lastReason: reason, status: "paused" };
}

/** Spend since the goal was set. */
export function spentUsd(current: Goal, costUsd: number | undefined): number {
  return Math.max(0, (costUsd ?? 0) - (current.costAtStart ?? 0));
}
