import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Task evals dispatch durable child workflows. Serialize evals so they do
  // not starve each other's children past the per-eval timeout (same
  // rationale as agent-subagents).
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
