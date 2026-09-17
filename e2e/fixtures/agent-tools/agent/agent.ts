import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const base = e2eAgentConfig({
  mock(request) {
    if (request.lastUserMessage?.includes("`callback_identity`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return { toolCalls: [{ name: "callback_identity", input: {} }] };
      }
      return "Callback identity checked.";
    }
    if (request.lastUserMessage?.includes("`schema_validate`")) {
      const roles = request.messages.map((message) => message.role);
      if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
        return {
          toolCalls: [
            {
              name: "schema_validate",
              input: {
                value: request.lastUserMessage?.includes("blank form") ? " " : "  normalized  ",
              },
            },
          ],
        };
      }
      const result = request.toolResults.at(-1);
      if (result?.name === "schema_validate" && result.isError) {
        return "Blank value rejected.";
      }
      return "Schema validation checked.";
    }
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
  },
});

export default defineAgent({
  ...base,
  experimental: {
    ...base.experimental,
    workflow: {
      ...base.experimental?.workflow,
      modelCallsPerStep: 3,
    },
  },
  reasoning: "high",
});
