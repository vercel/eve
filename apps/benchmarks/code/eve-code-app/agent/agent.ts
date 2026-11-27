import { defineAgent, type AgentReasoningDefinition } from "eve";

const VALID_REASONING = new Set<AgentReasoningDefinition>([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const model = process.env.EVE_CODE_BENCH_MODEL;
if (!model) {
  throw new Error("EVE_CODE_BENCH_MODEL must be set");
}

const rawReasoning = process.env.EVE_CODE_BENCH_REASONING ?? "high";
if (!VALID_REASONING.has(rawReasoning as AgentReasoningDefinition)) {
  throw new Error(`Unsupported EVE_CODE_BENCH_REASONING: ${rawReasoning}`);
}

export default defineAgent({
  model,
  reasoning: rawReasoning as AgentReasoningDefinition,
});
