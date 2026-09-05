import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage, userMessages, toolResults }) => {
      if (userMessages.some((message) => message.includes("CROSS-VERSION-WORKER-RESULT"))) {
        return "CROSS-VERSION-WORKER-RESULT";
      }
      if (lastUserMessage?.includes("CROSS-VERSION-WORKER-JOB")) {
        return "CROSS-VERSION-WORKER-RESULT";
      }
      if (lastUserMessage?.includes("CROSS-VERSION-START-WORKER")) {
        if (toolResults.some((result) => result.name === "agent")) {
          return "CROSS-VERSION-WORKER-STARTED";
        }
        return {
          toolCalls: [{ name: "agent", input: { message: "CROSS-VERSION-WORKER-JOB" } }],
        };
      }
      return lastUserMessage?.includes("Please wait for cross-version follow-up.") === true
        ? {
            toolCalls: [
              {
                id: "wait-for-cancellation",
                input: {},
                name: "wait-for-cancellation",
              },
            ],
          }
        : `Mock reply: ${lastUserMessage ?? ""}`;
    },
  }),
  reasoning: "high",
});
