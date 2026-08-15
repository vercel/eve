import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Test-only child for session-limit propagation. Call it exactly when the user asks for the limited-worker subagent.",
  limits: {
    maxInputTokensPerSession: 1,
  },
  ...e2eSubagentConfig(),
  reasoning: "high",
});
