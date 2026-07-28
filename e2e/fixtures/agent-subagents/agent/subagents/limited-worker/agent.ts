import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Test-only child for session-limit propagation. Call it exactly when the user asks for the limited-worker subagent.",
  limits: {
    maxInputTokensPerSession: 1,
  },
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
  reasoning: "high",
});
