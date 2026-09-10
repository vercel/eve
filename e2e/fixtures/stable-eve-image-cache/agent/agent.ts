import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel(({ toolResults }) => {
    const result = toolResults.at(-1);
    if (result !== undefined) return "done";
    return { toolCalls: [{ input: { command: "true" }, name: "bash" }] };
  }),
  modelContextWindowTokens: 1_000_000,
});
