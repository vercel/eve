import { recordUsage } from "#harness/usage-sink.js";
import { extractGatewayCostUsd } from "#harness/model-call/usage.js";
import type { DecisionOptions, DecisionQuestion, DecisionResult } from "#ai/decision-types.js";
import { decideWithTracing } from "#instrumentation/decide.js";

/** What a decision is for, recorded on its trace span as `agent.decision.purpose`. */
export type DecisionPurpose = "model-selection" | "tool-approval" | "agent-routing" | "custom";

/** Decide typed questions about shared state using eve's model authentication. */
export function decide<const Questions extends Readonly<Record<string, DecisionQuestion>>>(
  options: DecisionOptions<Questions>,
): Promise<DecisionResult<Questions>> {
  return decideFor("custom", options);
}

/** `decide` for eve's own decisions, which name their purpose on the trace. */
export async function decideFor<const Questions extends Readonly<Record<string, DecisionQuestion>>>(
  purpose: DecisionPurpose,
  options: DecisionOptions<Questions>,
): Promise<DecisionResult<Questions>> {
  const result = await decideWithTracing(options, purpose);
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
