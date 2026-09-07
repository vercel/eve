import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock(request) {
      if (request.lastUserMessage?.includes("`schema_validate`")) {
        const roles = request.messages.map((message) => message.role);
        if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
          return { toolCalls: [{ name: "schema_validate", input: { value: "  normalized  " } }] };
        }
        return "Schema validation checked.";
      }
      return `Mock reply: ${request.lastUserMessage ?? ""}`;
    },
  }),
  reasoning: "high",
});
