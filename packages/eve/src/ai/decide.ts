import { recordUsage } from "#harness/usage-sink.js";
import { extractGatewayCostUsd } from "#harness/model-call/usage.js";
import type { DecisionOptions, DecisionQuestion, DecisionResult } from "#ai/decision-types.js";
import { decideWithTracing } from "#instrumentation/decide.js";

/** Decide typed questions about shared state using eve's model authentication. */
export async function decide<const Questions extends Readonly<Record<string, DecisionQuestion>>>(
  options: DecisionOptions<Questions>,
): Promise<DecisionResult<Questions>> {
  const result = await decideWithTracing(options);
  await recordUsage(
    {
      costUsd: extractGatewayCostUsd(result.providerMetadata),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    { kind: "decision" },
  );
  return {
    answers: result.answers,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
