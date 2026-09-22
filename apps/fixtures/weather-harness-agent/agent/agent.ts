import { defineAgent } from "eve";
import { claudeCode } from "@ai-sdk/harness-claude-code";

export default defineAgent({
  build: {
    externalDependencies: ["@ai-sdk/harness-claude-code"],
  },
  harness: claudeCode,
});
