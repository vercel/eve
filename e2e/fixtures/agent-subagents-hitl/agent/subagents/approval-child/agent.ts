import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const MARKER = "PROXIED-ASK-APPROVED-6R9K";

export default defineAgent({
  description: "Ask for deployment approval and return a fixed marker after approval.",
  model: mockModel(({ lastUserMessage, messages, toolResults }) => {
    const result = toolResults.find((entry) => entry.name === "ask_question");
    if (
      result !== undefined ||
      messages.some((entry) => entry.text.includes('"status":"answered"'))
    ) {
      return MARKER;
    }
    if (lastUserMessage?.includes("Ask whether to deploy") === true) {
      return {
        toolCalls: [
          {
            input: {
              options: [
                { description: "Deploy now.", label: "Approve" },
                { description: "Do not deploy.", label: "Cancel" },
              ],
              question: "Approve the deployment?",
            },
            name: "ask_question",
          },
        ],
      };
    }
    return `Mock reply: ${lastUserMessage ?? ""}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
