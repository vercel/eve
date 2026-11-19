import type { AssertionResult, EveEvalVerdict } from "#evals/types.js";

export function computeEvalVerdict(input: {
  readonly error?: string;
  readonly assertions: readonly AssertionResult[];
  readonly skipReason?: string;
}): EveEvalVerdict {
  if (input.error !== undefined) return "failed";

  let demoted = false;
  for (const assertion of input.assertions) {
    if (assertion.passed !== false) continue;
    if (assertion.severity === "gate") return "failed";
    demoted = true;
  }

  if (input.skipReason !== undefined) return "skipped";
  return demoted ? "scored" : "passed";
}
