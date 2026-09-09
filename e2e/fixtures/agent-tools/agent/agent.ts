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
    return `Mock reply: ${request.lastUserMessage ?? ""}`;
  },
});

export default defineAgent({
  ...base,
  experimental: {
    ...base.experimental,
    maxModelCallsPerWorkflowStep: 3,
  },
  reasoning: "high",
});
