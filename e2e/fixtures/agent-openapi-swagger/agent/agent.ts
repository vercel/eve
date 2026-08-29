import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage, toolResults, tools }) => {
      if (!lastUserMessage?.includes("DYNAMIC_CONNECTION_E2E")) {
        return `Mock reply: ${lastUserMessage ?? ""}`;
      }
      if (toolResults.some((result) => result.name === "connection_search")) {
        return "DYNAMIC_CONNECTION_FOUND";
      }
      if (tools.some((tool) => tool.name === "connection_search")) {
        return {
          toolCalls: [
            {
              id: "dynamic-connection-search",
              input: { connection: "dynamic-catalog", keywords: "status", limit: 10 },
              name: "connection_search",
            },
          ],
        };
      }
      return "DYNAMIC_CONNECTION_MISSING";
    },
  }),
  reasoning: "high",
});
