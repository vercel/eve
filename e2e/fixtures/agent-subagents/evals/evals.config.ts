import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // Deterministic model turns reach nested Workflow waits immediately. Keep
  // separate evals from competing with the child workflows they are testing.
  maxConcurrency: 1,
  timeoutMs: 120_000,
});
