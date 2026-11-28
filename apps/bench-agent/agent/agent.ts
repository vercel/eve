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

const rawModel = process.env.EVE_BENCH_MODEL?.trim();
const model = rawModel && rawModel !== "none" ? rawModel : "anthropic/claude-sonnet-5.5";
const rawReasoning = process.env.EVE_BENCH_REASONING?.trim() || "high";
if (!VALID_REASONING.has(rawReasoning as AgentReasoningDefinition)) {
  throw new Error(`Unsupported EVE_BENCH_REASONING: ${rawReasoning}`);
}

export default defineAgent({
  model,
  reasoning: rawReasoning as AgentReasoningDefinition,
});
