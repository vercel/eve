import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxInputTokensPerSession: 5_000_000,
    maxOutputTokensPerSession: 100_000,
  },
  model: "anthropic/claude-opus-5.5-fast",
});
