import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  description: "Handle general tasks that do not belong to a specialist.",
  model: mockModel({
    modelId: "agent-router-parent",
    respond(request) {
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
      // agentRouter() runs each call as a task: a receipt now, the result in a
      // later <task_result> message once task_wait returns.
      const taskResult = request.messages.find(
        (message) => message.role === "user" && message.text.startsWith("<task_result"),
      );
      if (taskResult !== undefined) return taskResult.text;
      if (request.toolResults.some((entry) => entry.name === "agent")) {
        return { toolCalls: [{ name: "task_wait", input: {} }] };
      }
      return {
        toolCalls: [{ name: "agent", input: { message: "Return the root-copy marker." } }],
      };
    },
  }),
  modelContextWindowTokens: 1_000_000,
  tool: false,
});
