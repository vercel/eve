import { defineAgent } from "eve";

export default defineAgent({
  build: {
    externalDependencies: ["@ai-sdk/harness-claude-code"],
  },
  model: "openai/gpt-5.6-luna-fast",
});
