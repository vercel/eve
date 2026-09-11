import { defineAgent } from "eve";
import { claudeCode } from "@ai-sdk/harness-claude-code";

export default defineAgent({
  harness: claudeCode,
});
