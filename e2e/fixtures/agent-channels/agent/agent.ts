import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    agentStepsPerWorkflowStep: false,
    mock: ({ lastUserMessage }) =>
      lastUserMessage?.includes("Please wait for cross-version follow-up.") === true
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
