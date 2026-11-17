import type { EveEvalTaskResult } from "#evals/types.js";

export function outputOf(result: Pick<EveEvalTaskResult, "data" | "reply"> | undefined): unknown {
  if (result === undefined) return null;
  return result.data === undefined ? (result.reply ?? null) : result.data;
}
