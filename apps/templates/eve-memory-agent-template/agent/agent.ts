import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    sessionUsage: ({ window }) => window.inputTokens >= 300_000,
  },
  model: "anthropic/claude-fable-5.2",
});
