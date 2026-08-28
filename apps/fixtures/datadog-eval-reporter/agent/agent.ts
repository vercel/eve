import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ lastUserMessage, userMessageCount, userMessages }) => {
    if (lastUserMessage === "Say hello.") return "Hello from the Datadog fixture.";
    if (lastUserMessage === "Return alpha beta gamma.") return "alpha beta gamma";
    if (userMessageCount > 1) {
      return `Turn ${userMessageCount}: remembered ${userMessages[0]}`;
    }
    return `Turn ${userMessageCount}: ${lastUserMessage}`;
  }),
  modelContextWindowTokens: 1_000_000,
});
