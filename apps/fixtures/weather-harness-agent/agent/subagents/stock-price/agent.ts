import { defineAgent } from "eve";
import { claudeCode } from "@ai-sdk/harness-claude-code";

export default defineAgent({
  description: "Look up and summarize the current stock price for a ticker symbol.",
  harness: claudeCode,
});
