import { e2eAgentConfig, waitForTasks } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  description: "Handle general tasks that do not belong to a specialist.",
  model: mockModel({
    modelId: "agent-router-parent",
    // The router and inspect-agents start detached tasks; the script reads their results.
    respond: waitForTasks((request) => {
      if (request.userMessages.some((message) => message.includes("Return the root-copy marker"))) {
        if (request.tools.some((tool) => tool.name === "agent")) {
          throw new Error("The delegated root copy exposed the root-only agent router tool.");
        }
        const inspection = request.toolResults.find((entry) => entry.name === "inspect-agents");
        if (inspection === undefined) {
          return { toolCalls: [{ name: "inspect-agents", input: {} }] };
        }
        if (Object.hasOwn(inspection.output as object, "agent")) {
          throw new Error("The delegated root copy exposed recursive agent metadata.");
        }
        return "AGENT-ROUTER-ROOT-COPY-OK";
      }
      const result = request.toolResults.find((entry) => entry.name === "agent");
      return result === undefined
        ? {
            toolCalls: [
              {
                name: "agent",
                input: { message: "Return the root-copy marker." },
              },
            ],
          }
        : JSON.stringify(result.output);
    }),
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
