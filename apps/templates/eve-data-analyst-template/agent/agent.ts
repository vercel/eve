import { defineAgent } from "eve";

export default defineAgent({
  // pg has optional native bindings (pg-native), so keep it out of the bundle.
  build: { externalDependencies: ["pg"] },
  limits: {
    sessionUsage: ({ window }) =>
      window.inputTokens - window.cacheReadTokens >= 5_000_000 ||
      window.outputTokens >= 100_000,
  },
  model: "anthropic/claude-opus-5.5",
  reasoning: "medium",
});
