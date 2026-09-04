import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: ({ lastUserMessage }) =>
      lastUserMessage?.includes("Wait for a replacement turn.") === true
        ? {
            toolCalls: [
              {
                id: "wait-for-cancellation",
                input: {},
                name: "wait-for-cancellation",
              },
            ],
          }
        : `Mock reply: ${lastUserMessage ?? ""}`,
  }),
  reasoning: "high",
});
