import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const base = e2eAgentConfig({
  mock: ({ lastUserMessage }) =>
    lastUserMessage?.includes("Please wait for cancellation.") === true
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
});

export default defineAgent({
  ...base,
});
