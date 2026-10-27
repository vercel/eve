import type { Goal } from "./state.ts";

/** The goal as a tool reports it. */
export function describe(current: Goal | null) {
  if (current === null) return { goal: null };
  const { objective, status, runs, maxRuns, lastReason } = current;
  return { goal: { objective, status, runs, maxRuns, lastReason: lastReason ?? null } };
}
