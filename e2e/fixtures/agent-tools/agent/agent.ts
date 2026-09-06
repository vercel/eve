import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock(request) {
      if (request.lastUserMessage?.includes("`callback_identity`")) {
        const roles = request.messages.map((message) => message.role);
        if (roles.lastIndexOf("tool") <= roles.lastIndexOf("user")) {
          return { toolCalls: [{ name: "callback_identity", input: {} }] };
        }
        return "Callback identity checked.";
      }
      return `Mock reply: ${request.lastUserMessage ?? ""}`;
    },
  }),
  reasoning: "high",
});
