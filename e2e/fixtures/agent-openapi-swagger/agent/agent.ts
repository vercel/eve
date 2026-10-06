import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest } from "eve/evals";

/** Whether eve announced `name` in its catalog listing. */
function announced({ messages }: MockModelRequest, name: string): boolean {
  return messages.some(
    (message) => message.role === "user" && message.text.includes(`- ${name}: `),
  );
}

const config = e2eAgentConfig({
  mock: (request) => {
    const { lastUserMessage } = request;
    if (lastUserMessage?.includes("DYNAMIC_MCP_CONNECTION_E2E")) {
      return announced(request, "dynamic-mcp")
        ? "DYNAMIC_MCP_CONNECTION_FOUND"
        : "DYNAMIC_MCP_CONNECTION_MISSING";
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  },
});

export default defineAgent({
  ...config,
  reasoning: "high",
});
