import type { GoalVerdict } from "./judge.ts";
import type { Goal } from "./state.ts";

/** Continuation turns in a row without a tool call before a goal pauses. */
export const MAX_IDLE_RUNS = 2;

/** What a settled turn showed, read from the session view. */
export interface SettledTurn {
  readonly outcome: "completed" | "failed" | "cancelled";
  /** The turn ran only on the goal's own continuation, with no one else's input. */
  readonly continued: boolean;
  readonly toolCalls: number;
  /** Session spend so far, in US dollars, when the provider reported it. */
  readonly costUsd: number | undefined;
}

export type Check =
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "judge"; readonly idleRuns: number };

/** The guards that run before the judge: a turn that didn't complete, no progress, or no budget. */
export function check(
  current: Goal,
  turn: SettledTurn,
  limits: { readonly maxCostUsd?: number },
): Check {
  if (turn.outcome !== "completed") {
    return { kind: "pause", reason: `The turn ${turn.outcome}.` };
  }
  const idleRuns = turn.continued && turn.toolCalls === 0 ? current.idleRuns + 1 : 0;
  if (idleRuns >= MAX_IDLE_RUNS) {
    return {
      kind: "pause",
      reason: `${MAX_IDLE_RUNS} continuation turns in a row made no tool calls.`,
    };
  }
  if (current.runs >= current.maxRuns) {
    return { kind: "pause", reason: `The goal reached its limit of ${current.maxRuns} runs.` };
  }
  const spent = spentUsd(current, turn.costUsd);
  if (limits.maxCostUsd !== undefined && spent >= limits.maxCostUsd) {
    return {
      kind: "pause",
      reason: `The goal spent $${spent.toFixed(2)} of its $${limits.maxCostUsd.toFixed(2)} budget.`,
    };
  }
  return { idleRuns, kind: "judge" };
}

/** The goal after the judge's verdict, and the message that continues it, if it goes on. */
export function settle(
  current: Goal,
  verdict: GoalVerdict | undefined,
  idleRuns: number,
): { readonly goal: Goal; readonly message?: string } {
  if (verdict === undefined) {
    return { goal: pause(current, "The goal judge failed.") };
  }
  if (verdict.verdict !== "continue") {
    return { goal: { ...current, lastReason: verdict.reason, status: verdict.verdict } };
  }
  return {
    goal: { ...current, idleRuns, lastReason: verdict.reason, runs: current.runs + 1 },
    message: `Continue working toward the goal. ${verdict.reason}`,
  };
}

export function pause(current: Goal, reason: string): Goal {
  return { ...current, lastReason: reason, status: "paused" };
}

/** Spend since the goal was set. */
export function spentUsd(current: Goal, costUsd: number | undefined): number {
  return Math.max(0, (costUsd ?? 0) - (current.costAtStart ?? 0));
}
