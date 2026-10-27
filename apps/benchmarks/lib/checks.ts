import type { RunCompleteContext } from "@vercel/agent-eval";

// A run passes only when every grader test passes. For cases with many
// independent checks, the share of passing tests is the more useful signal: it
// moves when a change fixes one requirement, long before the whole case passes.

export interface GraderChecks {
  readonly passed: number;
  readonly total: number;
  readonly score: number;
}

// oxlint-disable-next-line eslint/no-control-regex -- strips ANSI color codes from Vitest output.
const ANSI = /\u001b\[[0-9;]*m/gu;

/**
 * Reads Vitest's `Tests` summary line from grader output. Returns `undefined`
 * when the grader never reported one, for example when it failed to start.
 */
export function graderChecks(output: unknown): GraderChecks | undefined {
  if (typeof output !== "string") return undefined;
  const line = output
    .replace(ANSI, "")
    .split("\n")
    .find((candidate) => /^\s*Tests\s+.*\(\d+\)\s*$/u.test(candidate));
  const total = Number(line?.match(/\((\d+)\)\s*$/u)?.[1] ?? 0);
  if (line === undefined || total === 0) return undefined;
  const passed = Number(line.match(/(\d+) passed/u)?.[1] ?? 0);
  return { passed, total, score: Math.round((passed / total) * 1000) / 1000 };
}

/** agent-eval `onRunComplete` hook that records grader checks on the run result. */
export function recordGraderChecks({
  runData,
}: Pick<RunCompleteContext, "runData">): RunCompleteContext["runData"] {
  const checks = graderChecks(runData.outputContent?.eval);
  if (checks === undefined) return runData;
  return {
    ...runData,
    result: { ...runData.result, analysis: { ...runData.result.analysis, checks } },
  };
}
