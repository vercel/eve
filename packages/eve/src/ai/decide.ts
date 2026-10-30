import { decideWithMetadata } from "#ai/decision-adapter.js";
import type { DecisionOptions, DecisionQuestion, DecisionResult } from "#ai/decision-types.js";

/** Decide typed questions about shared state using eve's model authentication. */
export async function decide<const Questions extends Readonly<Record<string, DecisionQuestion>>>(
  options: DecisionOptions<Questions>,
): Promise<DecisionResult<Questions>> {
  const result = await decideWithMetadata(options);
  return {
    answers: result.answers,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
