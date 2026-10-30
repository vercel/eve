import type { EveEvalTaskResult } from "#evals/types.js";

/** Structured null is an output, not a reason to fall back to reply text. */
export function outputOf(result: Pick<EveEvalTaskResult, "data" | "reply"> | undefined): unknown {
  if (result === undefined) return null;
  return result.data === undefined ? (result.reply ?? null) : result.data;
}
