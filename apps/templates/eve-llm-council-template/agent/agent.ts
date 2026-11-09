import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5",
  limits: {
    sessionUsage: ({ window }) => window.outputTokens >= 4_000,
  },
});
