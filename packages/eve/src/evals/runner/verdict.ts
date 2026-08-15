import type { AssertionResult, EveEvalVerdict } from "#evals/types.js";

/**
 * Computes the per-eval verdict from the execution outcome and recorded
 * assertions. An execution error or a failed gate assertion is a hard
 * failure; a below-threshold soft assertion at worst demotes the eval to
 * `"scored"` (which `eve eval --strict` later promotes to a failing exit
 * code). Soft assertions without a threshold are tracked-only and never
 * demote the verdict.
 */
export function computeEvalVerdict(input: {
  readonly error?: string;
  readonly assertions: readonly AssertionResult[];
  readonly skipReason?: string;
}): EveEvalVerdict {
  if (input.error !== undefined) return "failed";

  let demoted = false;
  for (const assertion of input.assertions) {
    if (assertion.passed) continue;
    if (assertion.severity === "gate") return "failed";
    demoted = true;
  }

  if (input.skipReason !== undefined) return "skipped";
  return demoted ? "scored" : "passed";
}
