import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const HITL_REQUEST = "GENERATED-PROGRAM-CHILD-HITL";

export default defineAgent({
  description: "Waits until its delegated turn is cancelled.",
  // The cancellation eval reads this synthetic child's terminal events after retirement.
  experimental: { workflow: { retention: "default" } },
  ...e2eSubagentConfig({
    mock: ({ lastUserMessage, toolResults, userMessages }) => {
      // A restarted task must not inherit the cancelled session's earlier message.
      if (lastUserMessage?.includes("SLEEPER-FOLLOW-UP") === true) {
        return `SLEEPER-REMEMBERS=${String(
          userMessages.some((entry) => entry.includes("Please wait for cancellation.")),
        )}`;
      }
      if (lastUserMessage?.includes(HITL_REQUEST) === true) {
        const answer = toolResults.find((result) => result.id === "child-question");
        return answer === undefined
          ? {
              toolCalls: [
                {
                  id: "child-question",
                  input: { question: "What marker should the child return?" },
                  name: "ask_question",
                },
              ],
            }
          : `CHILD_HITL_RESULT=${JSON.stringify(answer.output)}`;
      }
      return {
        toolCalls: [
          {
            id: "wait-for-cancellation",
            input: {},
            name: "wait-for-cancellation",
          },
        ],
      };
    },
  }),
});
