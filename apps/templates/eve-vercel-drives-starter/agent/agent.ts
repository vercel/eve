import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxInputTokensPerSession: 300_000,
  },
  model: "openai/gpt-6.1-sol-fast",
});
