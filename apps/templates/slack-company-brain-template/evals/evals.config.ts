import { defineEvalConfig } from "eve/evals";

// These evals call the agent's real model, so results can vary between runs.
// Use `eve eval --repeat 3` before trusting a prompt change.
export default defineEvalConfig({
  judge: { model: "openai/gpt-6-luna-decisions" },
  maxConcurrency: 4,
  timeoutMs: 180_000,
});
