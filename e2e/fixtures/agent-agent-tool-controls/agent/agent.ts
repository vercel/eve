import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel({
    modelId: "root-agent-tool-disabled",
    respond(request) {
      const internalCopy = request.userMessages.some((message) =>
        message.includes("E2E_INTERNAL_ROOT_COPY"),
      );
      if (internalCopy) return "INTERNAL-ROOT-COPY-OK";
      if (request.tools.some((tool) => tool.name === "agent")) {
        throw new Error("The built-in agent tool was exposed to the model.");
      }
      const result = request.toolResults.find((entry) => entry.name === "invoke-self");
      return result === undefined
        ? { toolCalls: [{ name: "invoke-self", input: {} }] }
        : JSON.stringify(result.output);
    },
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
