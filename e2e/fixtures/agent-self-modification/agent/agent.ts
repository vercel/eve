import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent, type AgentReasoningDefinition } from "eve";

const agentConfig = { ...e2eAgentConfig() };
if (process.env.EVE_EVAL_EXPERIMENT === "1" && process.env.EVE_EXPERIMENT_PARENT_MODEL) {
  agentConfig.model = process.env.EVE_EXPERIMENT_PARENT_MODEL;
}

export default defineAgent({
  ...agentConfig,
  reasoning:
    (process.env.EVE_EVAL_EXPERIMENT === "1"
      ? (process.env.EVE_EXPERIMENT_PARENT_REASONING as AgentReasoningDefinition | undefined)
      : undefined) ?? "high",
});
