import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  description: "Helps Alice and Bob choose a city for their trip.",
  modelContextWindowTokens: 32_000,
  model: mockModel(({ lastUserMessage, toolResults }) => {
    if (
      lastUserMessage?.includes("choose a city") &&
      !toolResults.some((result) => result.name === "ask_question")
    ) {
      return {
        toolCalls: [
          { id: "city", name: "ask_question", input: { prompt: "Which city should Alice visit?" } },
        ],
      };
    }
    return "Alice's itinerary is ready.";
  }),
});
