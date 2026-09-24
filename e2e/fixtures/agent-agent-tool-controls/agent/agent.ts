import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  description: "Coordinate specialist work and delegate focused subtasks.",
  model: mockModel({
    modelId: "root-agent-tool-disabled",
    // The workflow tools start detached tasks; the script reads their results.
    respond: waitForTasks((request) => {
      const internalCopy = request.userMessages.some((message) =>
        message.includes("E2E_INTERNAL_ROOT_COPY"),
      );
      if (internalCopy) return "INTERNAL-ROOT-COPY-OK";
      if (request.tools.some((tool) => ["agent", "operator", "researcher"].includes(tool.name))) {
        throw new Error("A hidden agent tool was exposed to the model.");
      }
      const inspectAgents = request.userMessages.some((message) =>
        message.includes("E2E_INSPECT_WORKFLOW_AGENTS"),
      );
      const toolName = inspectAgents ? "inspect-agents" : "invoke-self";
      const result = request.toolResults.find((entry) => entry.name === toolName);
      return result === undefined
        ? { toolCalls: [{ name: toolName, input: {} }] }
        : JSON.stringify(result.output);
    }),
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
