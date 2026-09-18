import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel({
    modelId: "agent-router-parent",
    respond(request) {
      if (request.userMessages.some((message) => message.includes("Return the root-copy marker"))) {
        const inspection = request.toolResults.find((entry) => entry.name === "inspect-agents");
        if (inspection === undefined) {
          return { toolCalls: [{ name: "inspect-agents", input: {} }] };
        }
        if (Object.hasOwn(inspection.output as object, "agent")) {
          throw new Error("The delegated root copy exposed recursive agent metadata.");
        }
        return "AGENT-ROUTER-ROOT-COPY-OK";
      }
      const result = request.toolResults.find((entry) => entry.name === "agent-router");
      return result === undefined
        ? {
            toolCalls: [
              {
                name: "agent-router",
                input: { message: "Return the root-copy marker." },
              },
            ],
          }
        : JSON.stringify(result.output);
    },
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
