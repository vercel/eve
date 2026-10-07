import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    // A recall question answers from the latest earlier assistant turn, so seeded history is
    // observable without a live model.
    mock: ({ lastUserMessage, messages }) =>
      lastUserMessage?.includes("code word")
        ? `Mock reply: ${[...messages].reverse().find((message) => message.role === "assistant")?.text ?? ""}`
        : `Mock reply: ${lastUserMessage ?? ""}`,
  }),
  reasoning: "high",
});
