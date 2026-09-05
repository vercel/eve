import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent(
  e2eAgentConfig({
    mock: (request) => {
      const message = request.lastUserMessage ?? "";
      if (message.includes("Please wait for cancellation.")) {
        return {
          toolCalls: [{ id: "wait-for-cancellation", input: {}, name: "wait-for-cancellation" }],
        };
      }
      return `Mock reply: ${message}`;
    },
  }),
);
