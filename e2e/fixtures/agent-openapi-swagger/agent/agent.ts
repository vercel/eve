import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest } from "eve/evals";

/** Whether eve announced `name` in its connection listing. */
function announced({ messages }: MockModelRequest, name: string): boolean {
  return messages.some(
    (message) => message.role === "user" && message.text.includes(`- ${name}: `),
  );
}

const config = e2eAgentConfig({
  mock: (request) => {
    const { lastUserMessage, toolResults } = request;
    if (lastUserMessage?.includes("DYNAMIC_MCP_CONNECTION_E2E")) {
      return announced(request, "dynamic-mcp")
        ? "DYNAMIC_MCP_CONNECTION_FOUND"
        : "DYNAMIC_MCP_CONNECTION_MISSING";
    }
    if (lastUserMessage?.includes("PETSTORE_EXECUTE_E2E")) {
      const result = toolResults.find((entry) => entry.name === "connection_execute");
      if (result === undefined) {
        return {
          toolCalls: [
            {
              id: "petstore-inventory",
              input: { connection: "petstore", tool: "getInventory", input: {} },
              name: "connection_execute",
            },
          ],
        };
      }
      return result.isError ? "inventory failed" : "inventory received";
    }
    if (!lastUserMessage?.includes("DYNAMIC_CONNECTION_E2E")) {
      return `Mock reply: ${lastUserMessage ?? ""}`;
    }
    if (toolResults.some((result) => result.name === "connection_search")) {
      return "DYNAMIC_CONNECTION_FOUND";
    }
    if (announced(request, "dynamic-catalog")) {
      return {
        toolCalls: [
          {
            id: "dynamic-connection-search",
            input: { connection: "dynamic-catalog", query: "status" },
            name: "connection_search",
          },
        ],
      };
    }
    return "DYNAMIC_CONNECTION_MISSING";
  },
});

export default defineAgent({
  ...config,
  // Measure Anthropic cache reuse through its native provider (see connection-cache.eval.ts).
  ...(typeof config.model === "string" && config.model.startsWith("anthropic/")
    ? { modelOptions: { providerOptions: { gateway: { only: ["anthropic"] } } } }
    : {}),
  reasoning: "high",
});
