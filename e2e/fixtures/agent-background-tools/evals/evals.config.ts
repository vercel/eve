import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Background tools dispatch durable task runs; serialize to avoid starving
  // children past the per-eval timeout.
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
